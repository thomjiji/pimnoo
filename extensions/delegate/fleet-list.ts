import { Editor, isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { fleetListLines } from "./format.ts";
import type { WorkerTaskState } from "./supervisor.ts";

/**
 * Popup-free worker list rendered as footer status entries.
 *
 * Pressing Down at an empty prompt activates the list: one footer line per
 * active worker (status, turn, current tool with duration, elapsed time),
 * Up/Down move the selection, Enter expands or collapses the selected
 * worker's recent activity, Escape (or Up past the top) returns to the
 * prompt. While inactive the entries are cleared and every key passes
 * through; the single summary line in the footer remains.
 *
 * Mechanics follow the same Pi-native surfaces as other subagent
 * extensions: rows are `ctx.ui.setStatus` entries (the footer area), key
 * handling goes through `ctx.ui.onTerminalInput` gated on an empty editor
 * and editor focus. A zero-line widget below the editor is registered
 * solely to capture the TUI instance for the focus check, so dialog keys
 * are never stolen.
 */

const FLEET_STATUS_KEY = "delegate-fleet-";
const FOCUS_WIDGET_KEY = "delegate-fleet-focus";
const TICK_MS = 500;

interface FleetUICtx {
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: undefined | ((tui: unknown) => { render(): string[]; invalidate(): void; dispose?(): void })): void;
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	getEditorText(): string;
}

interface TuiLike {
	focusedComponent?: unknown;
}

export class FleetList {
	private ui: FleetUICtx | undefined;
	private inputUnsub: (() => void) | undefined;
	private focusWidgetRegistered = false;
	private tui: TuiLike | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private active = false;
	private selectedIndex = 0;
	private expandedTaskId: string | undefined;
	private renderedRowCount = 0;

	constructor(private readonly getStates: () => WorkerTaskState[]) {}

	setUICtx(ui: FleetUICtx): void {
		if (ui === this.ui) return;
		this.inputUnsub?.();
		this.ui = ui;
		this.focusWidgetRegistered = false;
		this.tui = undefined;
		this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
	}

	/** Refresh rows and selection; clears the entries when there is nothing to show. */
	update(): void {
		if (!this.ui) return;
		const workers = this.activeWorkers();
		if (workers.length === 0) {
			this.ui.setWidget(FOCUS_WIDGET_KEY, undefined);
			this.focusWidgetRegistered = false;
			this.tui = undefined;
			this.clearEntries();
			return;
		}
		// The focus guard must exist while workers run, not just while the
		// list is active: an inactive list must still not steal keys from
		// open dialogs when Down is pressed inside them.
		this.ensureFocusWidget();
		if (!this.active) {
			this.clearEntries();
			return;
		}
		this.selectedIndex = Math.min(this.selectedIndex, workers.length - 1);
		const lines = this.renderLines();
		for (const [index, line] of lines.entries()) {
			this.ui.setStatus(`${FLEET_STATUS_KEY}${index}`, line);
		}
		for (let index = lines.length; index < this.renderedRowCount; index += 1) {
			this.ui.setStatus(`${FLEET_STATUS_KEY}${index}`, undefined);
		}
		this.renderedRowCount = lines.length;
		if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.inputUnsub?.();
		this.inputUnsub = undefined;
		this.clearEntries();
		this.ui?.setWidget(FOCUS_WIDGET_KEY, undefined);
		this.focusWidgetRegistered = false;
		this.tui = undefined;
		this.active = false;
		this.ui = undefined;
	}

	/** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
	private handleKey(data: string): { consume?: boolean; data?: string } | undefined {
		if (!this.ui) return undefined;
		if (isKeyRelease(data)) return undefined;
		if (!this.editorHasFocus()) {
			if (this.active) this.deactivate();
			return undefined;
		}
		if (!this.active) {
			const workers = this.activeWorkers();
			if (matchesKey(data, "down") && workers.length > 0 && this.ui.getEditorText() === "") {
				this.active = true;
				this.selectedIndex = 0;
				this.update();
				return { consume: true };
			}
			return undefined;
		}
		if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(this.activeWorkers().length - 1, this.selectedIndex + 1);
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			if (this.selectedIndex === 0) {
				this.deactivate();
				return { consume: true };
			}
			this.selectedIndex -= 1;
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, Key.escape)) {
			this.deactivate();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter)) {
			const selected = this.activeWorkers()[this.selectedIndex];
			if (selected) {
				this.expandedTaskId = this.expandedTaskId === selected.taskId ? undefined : selected.taskId;
				this.update();
			}
			return { consume: true };
		}
		// Any other key cancels navigation and flows to the editor.
		this.deactivate();
		return undefined;
	}

	private renderLines(): string[] {
		const states = this.getStates();
		const expandedWorker = states.find((state) => state.taskId === this.expandedTaskId);
		const expanded = expandedWorker ? { taskId: expandedWorker.taskId, lines: expandedWorker.activity ?? [] } : undefined;
		return fleetListLines(states, this.selectedIndex, expanded);
	}

	/** Register a zero-line widget so the TUI instance is available for focus checks. */
	private ensureFocusWidget(): void {
		if (this.focusWidgetRegistered || !this.ui) return;
		this.ui.setWidget(
			FOCUS_WIDGET_KEY,
			(tui) => {
				this.tui = tui as TuiLike;
				return {
					render: () => [],
					invalidate: () => {
						this.focusWidgetRegistered = false;
						this.tui = undefined;
					},
				};
			},
		);
		this.focusWidgetRegistered = true;
	}

	private clearEntries(): void {
		if (!this.ui) return;
		for (let index = 0; index < this.renderedRowCount; index += 1) {
			this.ui.setStatus(`${FLEET_STATUS_KEY}${index}`, undefined);
		}
		this.renderedRowCount = 0;
	}

	private activeWorkers(): WorkerTaskState[] {
		return this.getStates().filter((state) => !["completed", "failed", "aborted", "stopped", "limit-reached", "timed-out"].includes(state.status));
	}

	private deactivate(): void {
		this.active = false;
		this.selectedIndex = 0;
		this.expandedTaskId = undefined;
		this.clearEntries();
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** True when pi's prompt editor owns the keyboard (not a dialog or selector). */
	private editorHasFocus(): boolean {
		const focused = this.tui?.focusedComponent;
		return focused == null || focused instanceof Editor;
	}
}
