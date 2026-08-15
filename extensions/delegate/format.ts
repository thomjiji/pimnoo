import { TERMINAL_WORKER_STATUSES } from "./supervisor.ts";
import type { WorkerStatus, WorkerTaskState } from "./supervisor.ts";

export const MAX_FINAL_TEXT_LENGTH = 2000;

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}...`;
}

function stateLine(state: WorkerTaskState): string {
	const parts = [state.status];
	if (state.turns > 0) parts.push(`turn ${state.turns}`);
	if (state.status === "running" && state.lastTool) parts.push(`tool ${state.lastTool}`);
	if (state.error) parts.push(state.error);
	return `${state.taskId}: ${parts.join(", ")}`;
}

export function formatStartText(tasks: WorkerTaskState[]): string {
	return tasks
		.map(
			(task) =>
				`${task.taskId}: ${task.sessionName} ${task.status}\n  worktree: ${task.worktree}\n  branch: ${task.branch}\n  session: ${task.sessionFile}`,
		)
		.join("\n");
}

export function formatStatusText(states: WorkerTaskState[]): string {
	if (states.length === 0) return "No delegated workers are running.";
	return states
		.map(
			(state) =>
				`${stateLine(state)}\n  worktree: ${state.worktree}\n  session: ${state.sessionFile}`,
		)
		.join("\n");
}

export function formatReportText(states: WorkerTaskState[]): string {
	return states
		.map((state) => {
			const lines = [
				`${state.taskId} (${state.sessionName}): ${state.status}`,
				`  worktree: ${state.worktree}`,
				`  session: ${state.sessionFile}`,
			];
			if (state.finalText) lines.push(`  final: ${truncate(state.finalText, MAX_FINAL_TEXT_LENGTH)}`);
			if (state.error) lines.push(`  error: ${state.error}`);
			if (state.diagnostics) lines.push(`  diagnostics: ${truncate(state.diagnostics, 500)}`);
			return lines.join("\n");
		})
		.join("\n");
}

export function formatStopText(state: WorkerTaskState): string {
	return `Stopped worker ${state.taskId} (${state.sessionName}): ${state.status}\n  worktree: ${state.worktree}\n  session: ${state.sessionFile}`;
}

const SUMMARY_ORDER: readonly WorkerStatus[] = ["starting", "running", "waiting", "wrapping up", "completed", "failed", "aborted", "stopped", "limit-reached", "timed-out"];

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

/** One progress line per worker, used for live wait progress in the transcript. */
export function formatProgressText(states: WorkerTaskState[]): string {
	return states
		.map((state) => {
			const parts = [`${state.taskId} (${state.sessionName}): ${state.status}`];
			if (state.turns > 0) parts.push(`turn ${state.turns}`);
			if (state.status === "running" && state.lastTool) parts.push(`${state.lastTool} ${formatDuration(state.toolElapsedMs ?? 0)}`);
			if (state.elapsedMs !== undefined) parts.push(`elapsed ${formatDuration(state.elapsedMs)}`);
			return parts.join(" · ");
		})
		.join("\n");
}

/** The bounded recent-activity tail of one worker, for the logs action. */
export function formatLogsText(state: WorkerTaskState): string {
	const header = `${state.taskId} (${state.sessionName}): ${state.status}`;
	const body = (state.activity ?? []).join("\n");
	return `${header}\n${body || "  (no activity recorded)"}`;
}
/**
 * One-line footer summary for active workers only. Returns undefined when
 * every worker is terminal or settled, so the caller clears the status entry
 * instead of leaving stale history in the status bar.
 */
export function statusSummaryText(states: WorkerTaskState[]): string | undefined {
	const active = states.filter((state) => !TERMINAL_WORKER_STATUSES.includes(state.status));
	if (active.length === 0) return undefined;
	const counts = new Map<WorkerStatus, number>();
	for (const state of active) counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
	const parts = [`${active.length} worker${active.length === 1 ? "" : "s"}`];
	for (const status of SUMMARY_ORDER) {
		const count = counts.get(status);
		if (count) parts.push(`${count} ${status}`);
	}
	return `delegate: ${parts.join(", ")}`;
}
