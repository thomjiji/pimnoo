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

const SUMMARY_ORDER: readonly WorkerStatus[] = ["starting", "running", "waiting", "completed", "failed", "aborted", "stopped"];

export function statusSummaryText(states: WorkerTaskState[]): string {
	if (states.length === 0) return "delegate: no active workers";
	const counts = new Map<WorkerStatus, number>();
	for (const state of states) counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
	const parts = [`${states.length} worker${states.length === 1 ? "" : "s"}`];
	for (const status of SUMMARY_ORDER) {
		const count = counts.get(status);
		if (count) parts.push(`${count} ${status}`);
	}
	return `delegate: ${parts.join(", ")}`;
}
