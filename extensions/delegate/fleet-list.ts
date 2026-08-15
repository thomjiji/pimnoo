import { fleetListLines } from "./format.ts";
import type { WorkerTaskState } from "./supervisor.ts";

/**
 * Always-visible worker list rendered as footer status entries.
 *
 * While any worker is active, one footer line per worker shows its name,
 * status, turn, current tool with duration, and elapsed time; workers
 * that finished linger for a few seconds before dropping out. No key
 * handling and no selection: the list is display-only, like the rest of
 * the footer.
 */

const FLEET_STATUS_KEY = "delegate-fleet-";
const DEFAULT_TICK_MS = 200;
const DEFAULT_LINGER_MS = 4000;

const TERMINAL_STATUSES = ["completed", "failed", "aborted", "stopped", "limit-reached", "timed-out"];

export interface FleetUICtx {
	setStatus(key: string, text: string | undefined): void;
}

export class FleetList {
	private readonly getStates: () => WorkerTaskState[];
	private ui: FleetUICtx | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private renderedRowCount = 0;
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
			this.clearEntries();
			return;
		}
		const lines = fleetListLines(visible);
		for (const [index, line] of lines.entries()) {
			ui.setStatus(`${FLEET_STATUS_KEY}${index}`, line);
		}
		for (let index = lines.length; index < this.renderedRowCount; index += 1) {
			ui.setStatus(`${FLEET_STATUS_KEY}${index}`, undefined);
		}
		this.renderedRowCount = lines.length;
		if (!this.timer) this.timer = setInterval(() => this.tick(), this.tickMs);
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.clearEntries();
		this.ui = undefined;
	}

	private tick(): void {
		if (this.ui) this.update(this.ui, this.getStates());
	}

	private clearEntries(): void {
		if (!this.ui) return;
		for (let index = 0; index < this.renderedRowCount; index += 1) {
			this.ui.setStatus(`${FLEET_STATUS_KEY}${index}`, undefined);
		}
		this.renderedRowCount = 0;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}
