import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { JsonlRpcClient, RpcWorkerError } from "./rpc-client.ts";
import type { WorkerProcessLike } from "./rpc-client.ts";

const execFileAsync = promisify(execFile);

export const WORKER_ENVIRONMENT_MARKER = "PIMONO_DELEGATE_WORKER";

export { RpcWorkerError } from "./rpc-client.ts";

export function isDelegateWorkerProcess(environment: Record<string, string | undefined> = process.env): boolean {
	return environment[WORKER_ENVIRONMENT_MARKER] === "1";
}

/**
 * Worker lifecycle states.
 *
 * - starting: process spawned, startup handshake in progress.
 * - running: an agent run is active.
 * - waiting: agent settled but steering or follow-up messages are still queued.
 * - wrapping up: the soft turn threshold was crossed and a wrap-up steering
 *   message was sent; the worker is finishing within its grace period.
 * - completed: agent settled with no queued messages; the final report is available.
 * - failed: the worker died or its RPC stream became unusable.
 * - aborted: the active agent run was aborted; the worker is still alive.
 * - stopped: the parent terminated the worker process.
 * - limit-reached: the hard turn limit was exceeded without settling; aborted.
 * - timed-out: the task's total timeout elapsed; terminated.
 *
 * `completed`, `failed`, `aborted`, `stopped`, `limit-reached`, and
 * `timed-out` are terminal for `waitForTerminal`.
 */
export type WorkerStatus =
	| "starting"
	| "running"
	| "waiting"
	| "wrapping up"
	| "completed"
	| "failed"
	| "aborted"
	| "stopped"
	| "limit-reached"
	| "timed-out";

export const TERMINAL_WORKER_STATUSES: readonly WorkerStatus[] = ["completed", "failed", "aborted", "stopped", "limit-reached", "timed-out"];

const STICKY_STATUSES: readonly WorkerStatus[] = ["failed", "stopped", "limit-reached", "timed-out"];

const DEFAULT_MAX_TURNS = 60;
const DEFAULT_GRACE_MS = 30_000;
const ABORT_REQUEST_DEADLINE_MS = 2_000;
const MAX_ACTIVITY_LINES = 30;
const MAX_ACTIVITY_LINE_LENGTH = 160;

const WRAP_UP_MESSAGE =
	"Your turn budget is nearly exhausted. Stop exploring, finish your current work, and produce your final report now.";

export interface WorkerTaskDefinition {
	prompt: string;
	name?: string;
	role?: string;
	model?: string;
	thinkingLevel?: string;
	/** Hard agent-loop turn limit. Defaults to 60. */
	maxTurns?: number;
	/** Soft turn threshold for the wrap-up steering message. Defaults to maxTurns - 2. */
	softTurnThreshold?: number;
	/** Total active runtime budget in milliseconds; timed out and terminated when exceeded. */
	timeoutMs?: number;
}

interface TaskLimits {
	maxTurns?: number;
	softTurnThreshold?: number;
	timeoutMs?: number;
}

/** Fill missing per-task limits from top-level defaults; explicit task values win. */
export function applyTaskLimits<T extends TaskLimits>(tasks: T[], defaults: TaskLimits): T[] {
	if (defaults.maxTurns === undefined && defaults.softTurnThreshold === undefined && defaults.timeoutMs === undefined) return tasks;
	return tasks.map((task) => ({
		...task,
		maxTurns: task.maxTurns ?? defaults.maxTurns,
		softTurnThreshold: task.softTurnThreshold ?? defaults.softTurnThreshold,
		timeoutMs: task.timeoutMs ?? defaults.timeoutMs,
	}));
}

interface ResolvedLimits {
	maxTurns: number;
	softThreshold: number;
	timeoutMs?: number;
}

export interface StartWorkersRequest {
	repositoryCwd: string;
	sessionDir: string;
	parentSession?: string;
	parentModel?: string;
	thinkingLevel?: string;
	tasks: WorkerTaskDefinition[];
}

export interface WorkerStartResult {
	taskId: string;
	name?: string;
	branch: string;
	worktree: string;
	cwd: string;
	sessionFile: string;
	sessionName: string;
	status: WorkerStatus;
}

export interface WorkerTaskState extends WorkerStartResult {
	turns: number;
	pendingSteering: number;
	pendingFollowUps: number;
	lastTool?: string;
	finalText?: string;
	error?: string;
	diagnostics?: string;
	exitCode?: number | null;
	exitSignal?: string | null;
	/** Milliseconds since the worker process started. */
	elapsedMs?: number;
	/** Milliseconds the current tool has been running (0 when idle). */
	toolElapsedMs?: number;
	/** Bounded tail of recent activity lines, oldest first. */
	activity?: string[];
}

export interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface GitRunner {
	run(args: string[], cwd: string): Promise<GitResult>;
}

export interface PiCommand {
	command: string;
	args?: string[];
}

export interface WorkerSupervisorOptions {
	git?: GitRunner;
	spawnWorker?: (command: string, args: string[], options: Record<string, unknown>) => WorkerProcessLike;
	piCommand?: PiCommand;
	worktreeRoot?: string;
	environment?: Record<string, string>;
	/** Bounded grace period after the hard turn limit before a worker is aborted. Defaults to 30s. */
	graceMs?: number;
	/** Called after any worker state transition, for example to refresh TUI status surfaces. */
	onStateChange?: () => void;
}

interface PreparedWorktree {
	task: WorkerTaskDefinition;
	taskId: string;
	branch: string;
	worktree: string;
	limits: ResolvedLimits;
}

interface WorkerHandle {
	state: WorkerTaskState;
	process: WorkerProcessLike;
	rpc: JsonlRpcClient;
	limits: ResolvedLimits;
	startedAt: number;
	toolStartedAt?: number;
	activity: string[];
	/** True between agent_settled and the supervisor's settle reconciliation. */
	settling: boolean;
	/** How the settled run ended: aborted or a provider/run error. */
	pendingRunEnd?: "aborted" | "error";
	wrapUpSent: boolean;
	/** True while an abort/terminate path owns the worker's final state. */
	terminating: boolean;
	timeoutTimer?: ReturnType<typeof setTimeout>;
	graceTimer?: ReturnType<typeof setTimeout>;
}

interface Waiter {
	taskIds: Set<string>;
	resolve: (states: WorkerTaskState[]) => void;
}

export class WorkerSupervisorError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerSupervisorError";
	}
}

export class GitCommandError extends WorkerSupervisorError {
	readonly args: string[];
	readonly result: GitResult;

	constructor(args: string[], result: GitResult) {
		super(`git ${args.join(" ")} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`.trim());
		this.name = "GitCommandError";
		this.args = args;
		this.result = result;
	}
}

export class DefaultGitRunner implements GitRunner {
	async run(args: string[], cwd: string): Promise<GitResult> {
		try {
			const result = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 });
			return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0 };
		} catch (error) {
			const failure = error as { stdout?: string; stderr?: string; code?: number | string };
			return {
				stdout: String(failure.stdout ?? ""),
				stderr: String(failure.stderr ?? ""),
				exitCode: typeof failure.code === "number" ? failure.code : 1,
			};
		}
	}
}

export class WorkerSupervisor {
	private readonly git: GitRunner;
	private readonly spawnWorker: NonNullable<WorkerSupervisorOptions["spawnWorker"]>;
	private readonly piCommand: PiCommand;
	private readonly worktreeRoot?: string;
	private readonly environment: Record<string, string>;
	private readonly graceMs: number;
	private readonly onStateChange?: () => void;
	private readonly workers = new Map<string, WorkerHandle>();
	private readonly waiters = new Set<Waiter>();

	constructor(options: WorkerSupervisorOptions = {}) {
		this.git = options.git ?? new DefaultGitRunner();
		this.spawnWorker = options.spawnWorker ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions as never) as unknown as WorkerProcessLike);
		this.piCommand = options.piCommand ?? detectPiCommand();
		this.worktreeRoot = options.worktreeRoot;
		this.environment = options.environment ?? {};
		this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
		this.onStateChange = options.onStateChange;
	}

	async start(request: StartWorkersRequest): Promise<WorkerStartResult[]> {
		validateStartRequest(request);
		const repository = await this.prepareRepository(request.repositoryCwd);
		const prepared = await this.prepareWorktrees(repository, request.tasks);
		const started: WorkerHandle[] = [];
		try {
			for (const worktree of prepared) {
				const worker = await this.startWorker(worktree, request);
				started.push(worker);
				this.workers.set(worker.state.taskId, worker);
			}
			return started.map((worker) => ({ ...worker.state }));
		} catch (error) {
			for (const worker of started) {
				this.transition(worker, "stopped");
				await this.terminateWorker(worker);
			}
			await this.rollbackWorktrees(repository.root, prepared);
			for (const worker of started) await this.removeSessionFile(worker);
			throw error;
		}
	}

	/** Send a steering message that arrives before the worker's next model call. */
	async steer(taskId: string, message: string): Promise<WorkerTaskState> {
		const worker = this.requireWorker(taskId);
		if (typeof message !== "string" || !message.trim()) throw new WorkerSupervisorError("A steering message is required.");
		if (worker.state.status !== "running" && worker.state.status !== "wrapping up") {
			throw new WorkerSupervisorError(`Worker ${taskId} is ${worker.state.status}, not running; use follow_up for a settled worker.`);
		}
		await worker.rpc.request({ type: "steer", message });
		return this.snapshot(worker);
	}

	/** Send a follow-up message that waits until the current agent run settles. */
	async followUp(taskId: string, message: string): Promise<WorkerTaskState> {
		const worker = this.requireWorker(taskId);
		if (typeof message !== "string" || !message.trim()) throw new WorkerSupervisorError("A follow-up message is required.");
		if (worker.state.status === "starting" || STICKY_STATUSES.includes(worker.state.status) || worker.state.status === "aborted") {
			throw new WorkerSupervisorError(`Worker ${taskId} is ${worker.state.status} and cannot accept follow-up messages.`);
		}
		await worker.rpc.request({ type: "follow_up", message });
		return this.snapshot(worker);
	}

	/** Query one worker by task ID, or all workers when no ID is given. */
	status(taskId?: string): WorkerTaskState[] {
		if (taskId) return [this.snapshot(this.requireWorker(taskId))];
		return this.list();
	}

	/** Return the bounded recent-activity tail of one worker, oldest first. */
	logs(taskId: string): string[] {
		return [...this.requireWorker(taskId).activity];
	}

	/**
	 * Wait until the given workers (all of them by default) reach a terminal
	 * status, then return their final states. Resolves early with the current
	 * states when the parent aborts the wait via `signal`. When `onProgress`
	 * is given, it is called immediately and about once per second with the
	 * current states while the wait is pending.
	 */
	waitForTerminal(taskIds?: string[], signal?: AbortSignal, onProgress?: (states: WorkerTaskState[]) => void): Promise<WorkerTaskState[]> {
		const target = taskIds ? new Set(taskIds) : new Set(this.workers.keys());
		for (const id of target) {
			if (!this.workers.has(id)) throw new WorkerSupervisorError(`No worker with task ID ${id}`);
		}
		const snapshot = (): WorkerTaskState[] =>
			[...this.workers.values()].filter((worker) => target.has(worker.state.taskId)).map((worker) => this.snapshot(worker));
		if (target.size === 0) return Promise.resolve([]);
		if (signal?.aborted) return Promise.resolve(snapshot());
		if (snapshot().every((state) => TERMINAL_WORKER_STATUSES.includes(state.status))) return Promise.resolve(snapshot());
		const progressTimer = onProgress ? setInterval(() => onProgress(snapshot()), 1000) : undefined;
		onProgress?.(snapshot());
		return new Promise((resolve) => {
			const waiter: Waiter = { taskIds: target, resolve: () => {} };
			const finish = (states: WorkerTaskState[]): void => {
				if (progressTimer) clearInterval(progressTimer);
				this.waiters.delete(waiter);
				signal?.removeEventListener("abort", onAbort);
				resolve(states);
			};
			const onAbort = (): void => {
				// Parent cancellation propagates to the waited workers: terminate
				// them (preserving sessions and worktrees) and report their states.
				// Detach the waiter first so a settle racing with the stop cannot
				// resolve it with a pre-stop status.
				this.waiters.delete(waiter);
				void (async () => {
					for (const id of target) {
						const worker = this.workers.get(id);
						if (worker && !TERMINAL_WORKER_STATUSES.includes(worker.state.status)) {
							await this.abortAndTerminate(worker, "stopped");
						}
					}
					finish(snapshot());
				})();
			};
			waiter.resolve = finish;
			this.waiters.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * Stop one worker: abort its active run when one exists, then terminate
	 * the process. The worker's session file and worktree are preserved.
	 */
	async stop(taskId: string): Promise<WorkerTaskState> {
		const worker = this.requireWorker(taskId);
		const status = worker.state.status;
		if (status === "stopped" || status === "failed" || status === "limit-reached" || status === "timed-out") {
			return this.snapshot(worker); // The process is already gone or beyond saving.
		}
		if (status === "aborted" || status === "completed") {
			// No active run; terminate the settled process directly.
			this.transition(worker, "stopped");
			await this.terminateWorker(worker);
		} else {
			await this.abortAndTerminate(worker, "stopped");
		}
		return this.snapshot(worker);
	}

	list(): WorkerTaskState[] {
		return [...this.workers.values()].map((worker) => this.snapshot(worker));
	}

	async dispose(): Promise<void> {
		const workers = [...this.workers.values()];
		for (const worker of workers) this.transition(worker, "stopped");
		this.workers.clear();
		await Promise.all(workers.map(async (worker) => {
			await this.terminateWorker(worker);
		}));
	}

	private snapshot(worker: WorkerHandle): WorkerTaskState {
		const now = Date.now();
		return {
			...worker.state,
			elapsedMs: now - worker.startedAt,
			toolElapsedMs: worker.toolStartedAt !== undefined && worker.state.lastTool ? now - worker.toolStartedAt : 0,
			activity: [...worker.activity],
		};
	}

	private requireWorker(taskId: string): WorkerHandle {
		const worker = this.workers.get(taskId);
		if (!worker) throw new WorkerSupervisorError(`No worker with task ID ${taskId}`);
		return worker;
	}

	private transition(worker: WorkerHandle, status: WorkerStatus): void {
		if (worker.state.status === status) return;
		if (STICKY_STATUSES.includes(worker.state.status)) return;
		worker.state.status = status;
		if (TERMINAL_WORKER_STATUSES.includes(status)) this.clearTimers(worker);
		this.onStateChange?.();
		this.resolveWaiters();
	}

	private resolveWaiters(): void {
		for (const waiter of [...this.waiters]) {
			const targets = [...this.workers.values()].filter((worker) => waiter.taskIds.has(worker.state.taskId));
			// Workers mid-termination report their final state from the
			// abort/terminate path, not from settle reconciliation.
			if (targets.some((worker) => worker.terminating)) continue;
			const states = targets.map((worker) => this.snapshot(worker));
			if (states.every((state) => TERMINAL_WORKER_STATUSES.includes(state.status))) waiter.resolve(states);
		}
	}

	private async prepareRepository(repositoryCwd: string): Promise<{ root: string; revision: string }> {
		const status = await this.git.run(["status", "--porcelain=v1", "--untracked-files=all"], repositoryCwd);
		if (status.exitCode !== 0) throw new GitCommandError(["status", "--porcelain=v1", "--untracked-files=all"], status);
		if (status.stdout.trim()) {
			throw new WorkerSupervisorError("Refusing to delegate from a dirty parent worktree; commit or discard changes first.");
		}
		const rootResult = await this.git.run(["rev-parse", "--show-toplevel"], repositoryCwd);
		if (rootResult.exitCode !== 0) throw new GitCommandError(["rev-parse", "--show-toplevel"], rootResult);
		const revisionResult = await this.git.run(["rev-parse", "--verify", "HEAD"], repositoryCwd);
		if (revisionResult.exitCode !== 0) throw new GitCommandError(["rev-parse", "--verify", "HEAD"], revisionResult);
		return { root: resolve(rootResult.stdout.trim()), revision: revisionResult.stdout.trim() };
	}

	private async prepareWorktrees(repository: { root: string; revision: string }, tasks: WorkerTaskDefinition[]): Promise<PreparedWorktree[]> {
		const resolved = tasks.map((task) => ({ task, limits: resolveLimits(task) }));
		const root = resolve(this.worktreeRoot ?? join(dirname(repository.root), `.${basename(repository.root)}-delegate-worktrees`));
		await mkdir(root, { recursive: true });
		const prepared: PreparedWorktree[] = [];
		try {
			for (const { task, limits } of resolved) {
				const taskId = `task-${randomUUID()}`;
				const branch = `subagent/${taskId}`;
				const worktree = join(root, taskId);
				const result = await this.git.run(["worktree", "add", "-b", branch, worktree, repository.revision], repository.root);
				if (result.exitCode !== 0) throw new GitCommandError(["worktree", "add", "-b", branch, worktree, repository.revision], result);
				prepared.push({ task, taskId, branch, worktree, limits });
			}
			return prepared;
		} catch (error) {
			await this.rollbackWorktrees(repository.root, prepared);
			throw error;
		}
	}

	private async startWorker(prepared: PreparedWorktree, request: StartWorkersRequest): Promise<WorkerHandle> {
		const sessionName = `subagent/${normalizeSessionName(prepared.task.name) || prepared.taskId}`;
		const args = [
			...(this.piCommand.args ?? []),
			"--mode",
			"rpc",
			"--session-dir",
			request.sessionDir,
			"--tools",
			"read,bash,edit,write,grep,find,ls",
			"--exclude-tools",
			"delegate",
			"--append-system-prompt",
			workerSystemPrompt(prepared.worktree),
		];
		const model = prepared.task.model ?? request.parentModel;
		if (model) args.push("--model", model);
		const thinkingLevel = prepared.task.thinkingLevel ?? request.thinkingLevel;
		if (thinkingLevel) args.push("--thinking", thinkingLevel);
		const child = this.spawnWorker(this.piCommand.command, args, {
			cwd: prepared.worktree,
			env: { ...process.env, ...this.environment, [WORKER_ENVIRONMENT_MARKER]: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const rpc = new JsonlRpcClient(child);
		const state: WorkerTaskState = {
			taskId: prepared.taskId,
			name: prepared.task.name,
			branch: prepared.branch,
			worktree: prepared.worktree,
			cwd: prepared.worktree,
			sessionFile: "",
			sessionName,
			status: "starting",
			turns: 0,
			pendingSteering: 0,
			pendingFollowUps: 0,
		};
		const handle: WorkerHandle = {
			state,
			process: child,
			rpc,
			limits: prepared.limits,
			startedAt: Date.now(),
			activity: [],
			settling: false,
			wrapUpSent: false,
			terminating: false,
		};
		this.wireWorkerEvents(handle);
		try {
			const newSession = await rpc.request({ type: "new_session", ...(request.parentSession ? { parentSession: request.parentSession } : {}) });
			if (newSession.data?.cancelled === true) throw new RpcWorkerError("RPC worker refused to create its delegated session");
			await rpc.request({ type: "set_session_name", name: sessionName });
			const response = await rpc.request({ type: "get_state" });
			const sessionFile = response.data?.sessionFile;
			if (typeof sessionFile !== "string" || !sessionFile) throw new RpcWorkerError("RPC worker did not return a persistent session file");
			state.sessionFile = sessionFile;
			await rpc.request({ type: "prompt", message: buildTaskPrompt(prepared.task) });
			if (state.exitCode !== undefined) throw new RpcWorkerError("RPC worker exited before startup completed");
			this.transition(handle, "running");
			if (prepared.limits.timeoutMs) {
				handle.timeoutTimer = setTimeout(() => {
					void this.enforceTimeout(handle);
				}, prepared.limits.timeoutMs);
			}
			return handle;
		} catch (error) {
			this.transition(handle, "failed");
			await this.terminateWorker(handle);
			await this.removeSessionFile(handle);
			throw error;
		}
	}

	private recordActivity(worker: WorkerHandle, line: string): void {
		worker.activity.push(`${new Date().toISOString().slice(11, 19)} ${line.slice(0, MAX_ACTIVITY_LINE_LENGTH)}`);
		if (worker.activity.length > MAX_ACTIVITY_LINES) worker.activity.splice(0, worker.activity.length - MAX_ACTIVITY_LINES);
	}

	private wireWorkerEvents(worker: WorkerHandle): void {
		const { state, process, rpc } = worker;
		process.on("exit", (code, signal) => {
			state.exitCode = code;
			state.exitSignal = signal;
			if (state.status === "starting") return; // The startup path decides the outcome.
			if (state.status === "running" || state.status === "waiting" || state.status === "wrapping up" || state.status === "completed" || state.status === "aborted") {
				this.transition(worker, code === 0 ? "completed" : "failed");
				if (code !== 0) state.error = `RPC worker exited with code ${code}`;
			}
		});
		process.on("error", (error) => {
			state.error = error.message;
			this.transition(worker, "failed");
		});
		process.stderr?.on("data", (chunk) => {
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			state.diagnostics = `${state.diagnostics ?? ""}${text}`.slice(-2000);
		});
		rpc.onEvent((event) => {
			switch (event.type) {
				case "malformed":
					state.error = `Malformed RPC output: ${String(event.line)}`;
					this.transition(worker, "failed");
					break;
				case "agent_start":
					worker.settling = false;
					worker.pendingRunEnd = undefined;
					this.transition(worker, "running");
					// Re-arm the hard-limit grace when a revived run is already past the limit.
					this.checkTurnBudget(worker);
					break;
				case "turn_start":
					state.turns += 1;
					this.recordActivity(worker, `turn ${state.turns} started`);
					if (state.status === "starting" || state.status === "waiting") this.transition(worker, "running");
					this.checkTurnBudget(worker);
					break;
				case "tool_execution_start": {
					state.lastTool = typeof event.toolName === "string" ? event.toolName : undefined;
					worker.toolStartedAt = Date.now();
					const args = truncateText(JSON.stringify(event.args ?? {}), MAX_ACTIVITY_LINE_LENGTH - 30);
					this.recordActivity(worker, `tool ${state.lastTool ?? "?"} started: ${args}`);
					this.transition(worker, "running");
					break;
				}
				case "tool_execution_end": {
					this.recordActivity(worker, `tool ${state.lastTool ?? "?"} finished${event.isError ? " (error)" : ""}`);
					worker.toolStartedAt = undefined;
					state.lastTool = undefined;
					break;
				}
				case "queue_update": {
					state.pendingSteering = countMessages(event.steering);
					state.pendingFollowUps = countMessages(event.followUp);
					// Only the authoritative settle reconciliation may mark a worker
					// completed; draining the queue here would race follow-up delivery.
					if (!isActive(state.status) && state.pendingSteering + state.pendingFollowUps > 0) {
						this.transition(worker, "waiting");
					}
					break;
				}
				case "message_end": {
					const message = event.message as { role?: string; content?: unknown; stopReason?: string } | undefined;
					if (message?.role === "assistant") {
						const text = assistantText(message.content);
						if (text) {
							state.finalText = text;
							this.recordActivity(worker, `assistant: ${text}`);
						}
						if (message.stopReason === "aborted") worker.pendingRunEnd = "aborted";
						else if (message.stopReason === "error") worker.pendingRunEnd = "error";
					}
					break;
				}
				case "auto_retry_end":
					if (event.success === false) {
						state.error = `Provider error: ${String(event.finalError ?? "retry attempts exhausted")}`;
						this.transition(worker, "failed");
					}
					break;
				case "agent_settled":
					this.recordActivity(worker, "run settled");
					worker.settling = true;
					void this.reconcileSettle(worker);
					break;
				default:
					break;
			}
		});
	}

	/** After a settle, sync authoritative state from the worker: queued messages and final text. */
	private async reconcileSettle(worker: WorkerHandle): Promise<void> {
		try {
			const [stateResponse, textResponse] = await Promise.all([
				worker.rpc.request({ type: "get_state" }),
				worker.rpc.request({ type: "get_last_assistant_text" }),
			]);
			if (!worker.settling) return; // A new run started while we were querying.
			worker.settling = false;
			if (worker.terminating) return; // The abort/terminate path owns the final state.
			const data = stateResponse.data ?? {};
			const pending = Number(data.pendingMessageCount ?? 0) || 0;
			const text = typeof textResponse.data?.text === "string" ? textResponse.data.text : "";
			if (text) worker.state.finalText = text;
			if (worker.pendingRunEnd === "aborted") this.transition(worker, "aborted");
			else if (worker.pendingRunEnd === "error") {
				if (!worker.state.error) worker.state.error = "Run failed with an error stop reason";
				this.transition(worker, "failed");
			} else if (pending > 0 && !(worker.wrapUpSent && pending === 1 && text)) {
				// A single queued message after we sent our own wrap-up steering is
				// vestigial: the worker already settled with a final report, so the
				// wrap-up instruction can no longer be delivered before a model call.
				this.transition(worker, "waiting");
			} else {
				if (!worker.state.finalText) worker.state.error = "Completed without a final report";
				this.transition(worker, "completed");
			}
		} catch {
			// The worker died mid-query; the exit handler records the terminal state.
		}
	}

	private checkTurnBudget(worker: WorkerHandle): void {
		const { state } = worker;
		if (state.turns >= worker.limits.softThreshold && !worker.wrapUpSent) {
			worker.wrapUpSent = true;
			void this.sendWrapUp(worker);
			this.transition(worker, "wrapping up");
		}
		if (state.turns >= worker.limits.maxTurns && !worker.graceTimer) {
			worker.graceTimer = setTimeout(() => {
				void this.enforceHardLimit(worker);
			}, this.graceMs);
		}
	}

	private async sendWrapUp(worker: WorkerHandle): Promise<void> {
		try {
			await worker.rpc.request({ type: "steer", message: WRAP_UP_MESSAGE });
		} catch {
			// The worker may have died; the exit handler records the terminal state.
		}
	}

	private async enforceHardLimit(worker: WorkerHandle): Promise<void> {
		if (TERMINAL_WORKER_STATUSES.includes(worker.state.status)) return;
		await this.abortAndTerminate(worker, "limit-reached", `Turn limit reached after ${worker.state.turns} turns`);
	}

	private async enforceTimeout(worker: WorkerHandle): Promise<void> {
		if (TERMINAL_WORKER_STATUSES.includes(worker.state.status)) return;
		await this.abortAndTerminate(worker, "timed-out", `Timed out after ${worker.limits.timeoutMs}ms`);
	}

	private async abortAndTerminate(worker: WorkerHandle, status: "stopped" | "limit-reached" | "timed-out", errorMessage?: string): Promise<void> {
		if (TERMINAL_WORKER_STATUSES.includes(worker.state.status)) return;
		// Claim the final state before sending abort: the aborted run settles
		// with an error stop reason in real Pi, and settle reconciliation must
		// not classify it as a plain failure while we are terminating.
		worker.terminating = true;
		// Pi's abort awaits the agent becoming idle, so the response can hang
		// while a model call is in flight. Bound the wait: after the deadline
		// the process is terminated directly. The pending request is settled
		// by rpc.close() during termination.
		const abortResponse = worker.rpc.request({ type: "abort" }).catch(() => undefined);
		await Promise.race([abortResponse, sleep(ABORT_REQUEST_DEADLINE_MS)]);
		// Bounded grace so the aborted run can settle and be recorded in the session.
		await waitForStatus(worker, ["aborted", "completed", "waiting", "failed"], 300);
		if (errorMessage) worker.state.error = errorMessage;
		// Parent-initiated termination is authoritative; bypass the sticky guard
		// in case settle reconciliation already classified the aborted run.
		worker.state.status = status;
		worker.terminating = false;
		this.clearTimers(worker);
		this.onStateChange?.();
		this.resolveWaiters();
		await this.terminateWorker(worker);
	}

	private clearTimers(worker: WorkerHandle): void {
		if (worker.timeoutTimer) clearTimeout(worker.timeoutTimer);
		if (worker.graceTimer) clearTimeout(worker.graceTimer);
		worker.timeoutTimer = undefined;
		worker.graceTimer = undefined;
	}

	private async terminateWorker(worker: WorkerHandle): Promise<void> {
		this.clearTimers(worker);
		worker.rpc.close();
		try {
			worker.process.stdin?.end();
		} catch {
			// The process may already have closed its stdin.
		}
		if (worker.state.exitCode === undefined) {
			worker.process.kill("SIGTERM");
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
			if (worker.state.exitCode === undefined) worker.process.kill("SIGKILL");
		}
	}

	private async removeSessionFile(worker: WorkerHandle): Promise<void> {
		if (!worker.state.sessionFile) return;
		try {
			await rm(worker.state.sessionFile, { force: true });
		} catch {
			// Best effort; the rollback should not fail because of a session file.
		}
	}

	private async rollbackWorktrees(repositoryRoot: string, prepared: PreparedWorktree[]): Promise<void> {
		for (const worktree of [...prepared].reverse()) {
			await this.git.run(["worktree", "remove", "--force", worktree.worktree], repositoryRoot);
			await this.git.run(["branch", "-D", worktree.branch], repositoryRoot);
		}
	}
}

function isActive(status: WorkerStatus): boolean {
	return status === "starting" || status === "running" || status === "wrapping up";
}

function countMessages(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

function truncateText(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}...`;
}

function assistantText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.length > 0 ? parts.join("") : undefined;
}

function validateStartRequest(request: StartWorkersRequest): void {
	if (!request.repositoryCwd) throw new WorkerSupervisorError("A repository cwd is required.");
	if (!request.sessionDir) throw new WorkerSupervisorError("A session directory is required.");
	if (!Array.isArray(request.tasks) || request.tasks.length === 0) throw new WorkerSupervisorError("At least one worker task is required.");
	for (const [index, task] of request.tasks.entries()) {
		if (!task || typeof task.prompt !== "string" || !task.prompt.trim()) throw new WorkerSupervisorError(`Task ${index + 1} must include a non-empty prompt.`);
	}
}

function resolveLimits(task: WorkerTaskDefinition): ResolvedLimits {
	const maxTurns = task.maxTurns ?? DEFAULT_MAX_TURNS;
	const softThreshold = task.softTurnThreshold ?? Math.max(1, maxTurns - 2);
	if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new WorkerSupervisorError("maxTurns must be a positive integer.");
	if (!Number.isInteger(softThreshold) || softThreshold < 1 || softThreshold >= maxTurns) {
		throw new WorkerSupervisorError("softTurnThreshold must be a positive integer below maxTurns.");
	}
	if (task.timeoutMs !== undefined && (!Number.isInteger(task.timeoutMs) || task.timeoutMs < 1)) {
		throw new WorkerSupervisorError("timeoutMs must be a positive integer.");
	}
	return { maxTurns, softThreshold, timeoutMs: task.timeoutMs };
}

function detectPiCommand(): PiCommand {
	const configured = process.env.PIMONO_PI_BIN ?? process.env.PI_BIN;
	if (configured) return { command: configured };
	if (process.argv[1]) return { command: process.execPath, args: [process.argv[1]] };
	return { command: "pi" };
}

function normalizeSessionName(value: string | undefined): string {
	return value?.trim().replace(/\s+/g, " ").replace(/[\r\n]/g, " ") ?? "";
}

function workerSystemPrompt(worktree: string): string {
	return [
		"You are a headless delegated Pi worker.",
		"Your conversation starts clean; use only this task prompt and files in the current worktree as context.",
		`Work only in the assigned worktree: ${worktree}`,
		"Do not call, recreate, or ask another process to call the delegate tool.",
		"Use the available read, write, edit, and command tools to complete the task.",
		"When done, summarize the changes, tests, and any remaining concerns in your final response.",
	].join("\n");
}

function buildTaskPrompt(task: WorkerTaskDefinition): string {
	const sections = ["Delegated task"];
	if (task.role?.trim()) sections.push(`Role: ${normalizeSessionName(task.role)}`);
	sections.push(`Task prompt:\n${task.prompt}`);
	return sections.join("\n\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForStatus(worker: WorkerHandle, statuses: WorkerStatus[], timeoutMs: number): Promise<void> {
	if (statuses.includes(worker.state.status)) return;
	await new Promise<void>((resolvePromise) => {
		const timer = setInterval(() => {
			if (statuses.includes(worker.state.status)) {
				clearInterval(timer);
				clearTimeout(deadline);
				resolvePromise();
			}
		}, 10);
		const deadline = setTimeout(() => {
			clearInterval(timer);
			resolvePromise();
		}, timeoutMs);
	});
}
