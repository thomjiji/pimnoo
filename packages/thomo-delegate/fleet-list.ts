import { fleetListLines } from "./format.ts";
import type { WorkerTaskState } from "./supervisor.ts";

/**
 * Always-visible worker list rendered as an above-editor widget.
 *
 * While any worker is active, the widget shows a bold header with the
 * active count and one dim, box-drawing row per worker (name, status,
 * turn, current tool with duration, elapsed time); workers that finished
 * linger for a few seconds before dropping out. Colors come from the
 * active theme (bold header, dim rows), matching the footer's styling.
 * No key handling and no selection: the list is display-only.
 */

const FLEET_WIDGET_KEY = "delegate-fleet";
const DEFAULT_TICK_MS = 200;
const DEFAULT_LINGER_MS = 4000;

const TERMINAL_STATUSES = ["completed", "failed", "aborted", "stopped", "limit-reached", "timed-out"];

export interface FleetUICtx {
	setWidget(
		key: string,
		content: undefined | ((tui: unknown, theme: FleetTheme) => { render(): string[]; invalidate(): void; dispose?(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

export interface FleetTheme {
	bold(text: string): string;
	fg(name: string, text: string): string;
}

interface TuiLike {
	requestRender?: () => void;
}

export class FleetList {
	private readonly getStates: () => WorkerTaskState[];
	private ui: FleetUICtx | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private widgetRegistered = false;
	private tui: TuiLike | undefined;
	private lastVisibleLines: string[] = [];
	private readonly lastSeenActive = new Map<string, number>();
	private readonly tickMs: number;
	private readonly lingerMs: number;

	constructor(getStates: () => WorkerTaskState[], options: { tickMs?: number; lingerMs?: number } = {}) {
		this.getStates = getStates;
		this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
		this.lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
	}

	update(ui: FleetUICtx, states: WorkerTaskState[]): void {
		this.ui = ui;
		const now = Date.now();
		for (const state of states) {
			if (!TERMINAL_STATUSES.includes(state.status)) this.lastSeenActive.set(state.taskId, now);
		}
		const visible = states.filter(
			(state) => !TERMINAL_STATUSES.includes(state.status) || now - (this.lastSeenActive.get(state.taskId) ?? 0) < this.lingerMs,
		);
		this.lastVisibleLines = fleetListLines(visible);
		if (visible.length === 0) {
			ui.setWidget(FLEET_WIDGET_KEY, undefined);
			this.widgetRegistered = false;
			this.tui = undefined;
			this.stopTimer();
			return;
		}
		if (!this.widgetRegistered) {
			ui.setWidget(
				FLEET_WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui as TuiLike;
					return {
						render: () => this.renderWithTheme(theme),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender?.();
		}
		if (!this.timer) this.timer = setInterval(() => this.tick(), this.tickMs);
	}

	dispose(): void {
		this.stopTimer();
		this.ui?.setWidget(FLEET_WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.ui = undefined;
	}

	private renderWithTheme(theme: FleetTheme): string[] {
		return this.lastVisibleLines.map((line, index) => (index === 0 ? theme.bold(line) : theme.fg("dim", line)));
	}

	private tick(): void {
		if (this.ui) this.update(this.ui, this.getStates());
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
