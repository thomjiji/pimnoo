import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isDelegateWorkerProcess, WorkerSupervisor } from "./supervisor.ts";
import { formatReportText, formatStartText, formatStatusText, formatStopText, statusSummaryText } from "./format.ts";
import type { WorkerTaskState } from "./supervisor.ts";

const workerTaskSchema = Type.Object({
	prompt: Type.String({ description: "The complete task prompt to send to the clean worker context." }),
	name: Type.Optional(Type.String({ description: "Optional display name for the worker session." })),
	role: Type.Optional(Type.String({ description: "Optional role instruction, such as implementer or reviewer." })),
	model: Type.Optional(Type.String({ description: "Optional provider/model override." })),
	thinkingLevel: Type.Optional(Type.String({ description: "Optional thinking level override." })),
});

interface DelegateParameters {
	action: "start" | "steer" | "follow_up" | "status" | "wait" | "stop";
	tasks?: Array<{ prompt: string; name?: string; role?: string; model?: string; thinkingLevel?: string }>;
	taskId?: string;
	taskIds?: string[];
	message?: string;
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

	let lastUi: UiStatusSink | undefined;
	const supervisor = new WorkerSupervisor({
		onStateChange: () => {
			if (!lastUi) return;
			try {
				lastUi.setStatus("delegate", statusSummaryText(supervisor.list()));
			} catch {
				// Status surfaces are best effort; never break the supervisor for them.
			}
		},
	});

	function refreshStatus(ctx: ExtensionContext): void {
		lastUi = ctx.ui;
		try {
			ctx.ui.setStatus("delegate", statusSummaryText(supervisor.list()));
		} catch {
			// Best effort, as above.
		}
	}

	async function runAction(params: DelegateParameters, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<{ text: string; tasks: WorkerTaskState[] }> {
		switch (params.action) {
			case "start": {
				const tasks = params.tasks ?? [];
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
				const states = await supervisor.waitForTerminal(params.taskIds, signal);
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
			"Use delegate follow_up for messages that should wait until a worker settles; use delegate steer only while a worker is running.",
			"Include all required background and constraints explicitly in each task prompt; worker history is not inherited.",
			"Use separate tasks only for work that can safely proceed in independent Git worktrees.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("steer"), Type.Literal("follow_up"), Type.Literal("status"), Type.Literal("wait"), Type.Literal("stop")]),
			tasks: Type.Optional(Type.Array(workerTaskSchema, { minItems: 1, description: "Worker tasks to start (start only)." })),
			taskId: Type.Optional(Type.String({ description: "Target task ID (steer, follow_up, status, stop)." })),
			taskIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Task IDs to wait for (wait only; defaults to all workers)." })),
			message: Type.Optional(Type.String({ description: "Message text (steer, follow_up)." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const result = await runAction(params as unknown as DelegateParameters, signal ?? undefined, ctx);
				refreshStatus(ctx);
				return {
					content: [{ type: "text", text: result.text }],
					details: { action: params.action, tasks: result.tasks },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				refreshStatus(ctx);
				return {
					content: [{ type: "text", text: `Unable to ${params.action} delegated workers: ${message}` }],
					details: { action: params.action, error: message },
					isError: true,
				};
			}
		},
	});

	pi.on("session_shutdown", async () => {
		await supervisor.dispose();
	});
}
