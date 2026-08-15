import { Editor, isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { fleetListLines } from "./format.ts";
import type { WorkerTaskState } from "./supervisor.ts";

/**
 * Popup-free worker list rendered as a below-editor widget.
 *
 * Pressing Down at an empty prompt activates the list; Up/Down move the
 * selection, Enter expands or collapses the selected worker's recent
 * activity, Escape (or Up past the top) returns to the prompt. While
 * inactive the widget is not rendered at all and every key passes through.
 *
 * Mechanics follow the same Pi-native surfaces as other subagent
 * extensions: the list is a render-only widget and all key handling goes
 * through `ctx.ui.onTerminalInput`, gated on an empty editor and editor
 * focus so typing and dialogs are never disturbed.
 */

const FLEET_WIDGET_KEY = "delegate-fleet";
const TICK_MS = 500;
const EXPANDED_ACTIVITY_LINES = 5;

interface FleetUICtx {
	setWidget(key: string, content: undefined | ((tui: unknown) => { render(): string[]; invalidate(): void; dispose?(): void }), options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	getEditorText(): string;
}

interface WidgetHandle {
	requestRender?: () => void;
}

export class FleetList {
	private ui: FleetUICtx | undefined;
	private inputUnsub: (() => void) | undefined;
	private widgetRegistered = false;
	private widgetHandle: WidgetHandle | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private active = false;
	private selectedIndex = 0;
	private expandedTaskId: string | undefined;

	constructor(private readonly getStates: () => WorkerTaskState[]) {}

	setUICtx(ui: FleetUICtx): void {
		if (ui === this.ui) return;
		this.inputUnsub?.();
		this.ui = ui;
		this.widgetRegistered = false;
		this.widgetHandle = undefined;
		this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
	}

	/** Refresh rows and selection; clears the widget when there is nothing to show. */
	update(): void {
		if (!this.ui) return;
		const workers = this.activeWorkers();
		if (!this.active || workers.length === 0) {
			if (this.active) this.deactivate();
			if (this.widgetRegistered) {
				this.ui.setWidget(FLEET_WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.widgetHandle = undefined;
			}
			if (this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
			return;
		}
		this.selectedIndex = Math.min(this.selectedIndex, workers.length - 1);
		if (!this.widgetRegistered) {
			this.ui.setWidget(
				FLEET_WIDGET_KEY,
				(tui) => {
					this.widgetHandle = tui as WidgetHandle;
					return {
						render: () => this.renderLines(),
						invalidate: () => {
							this.widgetRegistered = false;
							this.widgetHandle = undefined;
						},
					};
				},
				{ placement: "belowEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.widgetHandle?.requestRender?.();
		}
		if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.inputUnsub?.();
		this.inputUnsub = undefined;
		if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.widgetHandle = undefined;
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

	private activeWorkers(): WorkerTaskState[] {
		return this.getStates().filter((state) => !["completed", "failed", "aborted", "stopped", "limit-reached", "timed-out"].includes(state.status));
	}

	private deactivate(): void {
		this.active = false;
		this.selectedIndex = 0;
		this.expandedTaskId = undefined;
		this.update();
	}

	/** True when pi's prompt editor owns the keyboard (not a dialog or selector). */
	private editorHasFocus(): boolean {
		const focused = (this.widgetHandle as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		return focused == null || focused instanceof Editor;
	}
}
