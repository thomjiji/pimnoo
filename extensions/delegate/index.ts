import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { applyTaskLimits, isDelegateWorkerProcess, TERMINAL_WORKER_STATUSES, WorkerSupervisor } from "./supervisor.ts";
import { FleetList } from "./fleet-list.ts";
import { formatLogsText, formatProgressText, formatReportText, formatStartText, formatStatusText, formatStopText, workerReportText } from "./format.ts";
import type { WorkerReportEntry } from "./format.ts";
import type { WorkerTaskState } from "./supervisor.ts";

const workerTaskSchema = Type.Object({
	prompt: Type.String({ description: "The complete task prompt to send to the clean worker context." }),
	name: Type.Optional(Type.String({ description: "Optional display name for the worker session." })),
	role: Type.Optional(Type.String({ description: "Optional role instruction, such as implementer or reviewer." })),
	model: Type.Optional(Type.String({ description: "Optional provider/model override." })),
	thinkingLevel: Type.Optional(Type.String({ description: "Optional thinking level override." })),
	maxTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Hard agent-loop turn limit for this task (default 60)." })),
	softTurnThreshold: Type.Optional(Type.Integer({ minimum: 1, description: "Turn count at which the worker receives a wrap-up steering message (default maxTurns - 2)." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Total active runtime budget in milliseconds; the worker is terminated when exceeded." })),
});

interface DelegateParameters {
	action: "start" | "steer" | "follow_up" | "status" | "wait" | "stop" | "logs";
	tasks?: Array<{
		prompt: string;
		name?: string;
		role?: string;
		model?: string;
		thinkingLevel?: string;
		maxTurns?: number;
		softTurnThreshold?: number;
		timeoutMs?: number;
	}>;
	taskId?: string;
	taskIds?: string[];
	message?: string;
	maxTurns?: number;
	softTurnThreshold?: number;
	timeoutMs?: number;
}

function modelName(ctx: ExtensionContext): string | undefined {
	if (!ctx.model) return undefined;
	return `${ctx.model.provider}/${ctx.model.id}`;
}

function requireString(value: unknown, action: string, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`delegate ${action} requires a non-empty ${field}.`);
	return value;
}

interface UiStatusSink {
	setStatus(key: string, text: string | undefined): void;
}

export default function (pi: ExtensionAPI) {
	if (isDelegateWorkerProcess()) return;

	const supervisor = new WorkerSupervisor({
		onStateChange: () => {
			refreshSurfaces();
			reportTerminalWorkers();
		},
	});
	const fleetList = new FleetList(() => supervisor.list());
	let lastUi: UiStatusSink | undefined;

	// Completion entries appended to the main transcript when a worker
	// reaches a terminal state. Display-only: custom entries never enter
	// the LLM context, so the reports stay visible without polluting the
	// main agent's context; wait/status still carry the full text.
	pi.registerEntryRenderer<WorkerReportEntry>("delegate-worker-report", (entry, _options, theme) => {
		if (!entry.data) return undefined;
		return new Text(workerReportText(entry.data, theme), 0, 0);
	});
	const reportedTerminal = new Set<string>();
	function reportTerminalWorkers(): void {
		for (const state of supervisor.list()) {
			if (!TERMINAL_WORKER_STATUSES.includes(state.status)) continue;
			if (reportedTerminal.has(state.taskId)) continue;
			reportedTerminal.add(state.taskId);
			try {
				pi.appendEntry<WorkerReportEntry>("delegate-worker-report", {
					taskId: state.taskId,
					sessionName: state.sessionName,
					status: state.status,
					turns: state.turns,
					elapsedMs: state.elapsedMs,
					finalText: state.finalText,
					error: state.error,
					sessionFile: state.sessionFile,
				});
			} catch {
				// The session may be shutting down; the entry is best effort.
			}
		}
	}

	function refreshSurfaces(ctx?: ExtensionContext): void {
		if (ctx) lastUi = ctx.ui;
		if (!lastUi) return;
		try {
			fleetList.update(lastUi, supervisor.list());
		} catch {
			// Status surfaces are best effort; never break the supervisor for them.
		}
	}

	async function runAction(
		params: DelegateParameters,
		signal: AbortSignal | undefined,
		onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<{ text: string; tasks: WorkerTaskState[] }> {
		switch (params.action) {
			case "start": {
				const tasks = applyTaskLimits(params.tasks ?? [], params);
				const started = await supervisor.start({
					repositoryCwd: ctx.cwd,
					sessionDir: ctx.sessionManager.getSessionDir(),
					parentSession: ctx.sessionManager.getSessionFile(),
					parentModel: modelName(ctx),
					thinkingLevel: ctx.thinkingLevel,
					tasks,
				});
				return { text: `Started ${started.length} delegated worker task(s).\n${formatStartText(started)}`, tasks: started };
			}
			case "steer": {
				const taskId = requireString(params.taskId, "steer", "taskId");
				const message = requireString(params.message, "steer", "message");
				const state = await supervisor.steer(taskId, message);
				return { text: `Steered worker ${taskId}.\n${formatStatusText([state])}`, tasks: [state] };
			}
			case "follow_up": {
				const taskId = requireString(params.taskId, "follow_up", "taskId");
				const message = requireString(params.message, "follow_up", "message");
				const state = await supervisor.followUp(taskId, message);
				return { text: `Queued follow-up for worker ${taskId}.\n${formatStatusText([state])}`, tasks: [state] };
			}
			case "status": {
				const states = params.taskId ? supervisor.status(params.taskId) : supervisor.status();
				return { text: formatStatusText(states), tasks: states };
			}
			case "wait": {
				const states = await supervisor.waitForTerminal(params.taskIds, signal, (progress) => {
					onUpdate?.({ content: [{ type: "text", text: formatProgressText(progress) }] });
				});
				const cancelled = signal?.aborted === true;
				return {
					text: `${cancelled ? "Wait cancelled by parent; current states:\n" : ""}${formatReportText(states)}`,
					tasks: states,
				};
			}
			case "stop": {
				const taskId = requireString(params.taskId, "stop", "taskId");
				const state = await supervisor.stop(taskId);
				return { text: formatStopText(state), tasks: [state] };
			}
			case "logs": {
				const taskId = requireString(params.taskId, "logs", "taskId");
				const state = supervisor.status(taskId)[0];
				return { text: formatLogsText(state), tasks: [state] };
			}
		}
	}

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Start and supervise independent headless Pi RPC workers in clean Git worktrees. Workers receive only the supplied task prompts and cannot delegate recursively.",
		promptSnippet: "Start, steer, wait for, or stop isolated headless worker tasks",
		promptGuidelines: [
			"Use delegate start to launch workers, delegate status to inspect them, and delegate wait to collect their final reports.",
			"Use delegate logs to read a worker's recent activity when you need to know what it is doing right now.",
			"Use delegate follow_up for messages that should wait until a worker settles; use delegate steer only while a worker is running.",
			"When the current model is stuck, delegate a consultation worker with a stronger model and higher thinking level, and include the problem, attempts, and errors in the task prompt.",
			"Set maxTurns, softTurnThreshold, or timeoutMs per task (or top-level as defaults) to bound worker runtime; unset limits default to 60 turns.",
			"Include all required background and constraints explicitly in each task prompt; worker history is not inherited.",
			"Use separate tasks only for work that can safely proceed in independent Git worktrees.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("steer"), Type.Literal("follow_up"), Type.Literal("status"), Type.Literal("wait"), Type.Literal("stop"), Type.Literal("logs")]),
			tasks: Type.Optional(Type.Array(workerTaskSchema, { minItems: 1, description: "Worker tasks to start (start only)." })),
			taskId: Type.Optional(Type.String({ description: "Target task ID (steer, follow_up, status, stop, logs)." })),
			taskIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Task IDs to wait for (wait only; defaults to all workers)." })),
			message: Type.Optional(Type.String({ description: "Message text (steer, follow_up)." })),
			maxTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Default hard turn limit for tasks that do not set their own (start only)." })),
			softTurnThreshold: Type.Optional(Type.Integer({ minimum: 1, description: "Default soft turn threshold for tasks that do not set their own (start only)." })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Default total runtime budget in milliseconds for tasks that do not set their own (start only)." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				const result = await runAction(params as unknown as DelegateParameters, signal ?? undefined, onUpdate, ctx);
				refreshSurfaces(ctx);
				reportTerminalWorkers();
				return {
					content: [{ type: "text", text: result.text }],
					details: { action: params.action, tasks: result.tasks },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				refreshSurfaces(ctx);
				return {
					content: [{ type: "text", text: `Unable to ${params.action} delegated workers: ${message}` }],
					details: { action: params.action, error: message },
					isError: true,
				};
			}
		},
	});

	pi.on("session_shutdown", async () => {
		fleetList.dispose();
		await supervisor.dispose();
	});
}
