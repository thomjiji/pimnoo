import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isDelegateWorkerProcess, WorkerSupervisor } from "./supervisor.ts";

const workerTaskSchema = Type.Object({
	prompt: Type.String({ description: "The complete task prompt to send to the clean worker context." }),
	name: Type.Optional(Type.String({ description: "Optional display name for the worker session." })),
	role: Type.Optional(Type.String({ description: "Optional role instruction, such as implementer or reviewer." })),
	model: Type.Optional(Type.String({ description: "Optional provider/model override." })),
	thinkingLevel: Type.Optional(Type.String({ description: "Optional thinking level override." })),
});

function modelName(ctx: ExtensionContext): string | undefined {
	if (!ctx.model) return undefined;
	return `${ctx.model.provider}/${ctx.model.id}`;
}

function resultText(tasks: Array<{ taskId: string; worktree: string; branch: string; sessionFile: string; sessionName: string }>): string {
	return tasks
		.map(
			(task) =>
				`${task.taskId}: ${task.sessionName} running\n  worktree: ${task.worktree}\n  branch: ${task.branch}\n  session: ${task.sessionFile}`,
		)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	if (isDelegateWorkerProcess()) return;

	const supervisor = new WorkerSupervisor();
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Start one or more independent headless Pi RPC workers in clean Git worktrees. Workers receive only the supplied task prompts and cannot delegate recursively.",
		promptSnippet: "Start isolated headless worker tasks",
		promptGuidelines: [
			"Include all required background and constraints explicitly in each task prompt; worker history is not inherited.",
			"Use separate tasks only for work that can safely proceed in independent Git worktrees.",
		],
		parameters: Type.Object({
			action: Type.Literal("start"),
			tasks: Type.Array(workerTaskSchema, { minItems: 1, description: "One or more independent worker tasks." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const tasks = await supervisor.start({
					repositoryCwd: ctx.cwd,
					sessionDir: ctx.sessionManager.getSessionDir(),
					parentSession: ctx.sessionManager.getSessionFile(),
					parentModel: modelName(ctx),
					thinkingLevel: ctx.thinkingLevel,
					tasks: params.tasks,
				});
				return {
					content: [{ type: "text", text: `Started ${tasks.length} delegated worker task(s).\n${resultText(tasks)}` }],
					details: { action: "start", tasks },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Unable to start delegated workers: ${message}` }],
					details: { action: "start", error: message },
					isError: true,
				};
			}
		},
	});

	pi.on("session_shutdown", async () => {
		await supervisor.dispose();
	});
}
