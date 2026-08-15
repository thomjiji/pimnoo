import { fleetListLines } from "./format.ts";
import type { WorkerTaskState } from "./supervisor.ts";

/**
 * Always-visible worker list rendered as a below-editor widget.
 *
 * While any worker is active, the widget shows one row per worker (name,
 * status, turn, current tool with duration, elapsed time) below the
 * editor, directly above the footer; workers that finished linger for a
 * few seconds before dropping out. No key handling and no selection:
 * the list is display-only, and the footer itself stays untouched.
 *
 * Pi's footer is strictly single-line (extension status entries are
 * joined and truncated), so the widget is the only surface that can
 * stack rows.
 */

const FLEET_WIDGET_KEY = "delegate-fleet";
const DEFAULT_TICK_MS = 200;
const DEFAULT_LINGER_MS = 4000;

const TERMINAL_STATUSES = ["completed", "failed", "aborted", "stopped", "limit-reached", "timed-out"];

export interface FleetUICtx {
	setWidget(key: string, lines: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
}

export class FleetList {
	private readonly getStates: () => WorkerTaskState[];
	private ui: FleetUICtx | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
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
		if (visible.length === 0) {
			ui.setWidget(FLEET_WIDGET_KEY, undefined);
			this.stopTimer();
			return;
		}
		ui.setWidget(FLEET_WIDGET_KEY, fleetListLines(visible), { placement: "aboveEditor" });
		if (!this.timer) this.timer = setInterval(() => this.tick(), this.tickMs);
	}

	dispose(): void {
		this.stopTimer();
		this.ui?.setWidget(FLEET_WIDGET_KEY, undefined);
		this.ui = undefined;
	}

	private tick(): void {
		if (this.ui) this.update(this.ui, this.getStates());
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
