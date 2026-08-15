import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WORKER_ENVIRONMENT_MARKER = "PIMONO_DELEGATE_WORKER";

export function isDelegateWorkerProcess(environment: Record<string, string | undefined> = process.env): boolean {
	return environment[WORKER_ENVIRONMENT_MARKER] === "1";
}

export type WorkerStatus = "starting" | "running" | "exited" | "failed";

export interface WorkerTaskDefinition {
	prompt: string;
	name?: string;
	role?: string;
	model?: string;
	thinkingLevel?: string;
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
	exitCode?: number | null;
	exitSignal?: string | null;
	error?: string;
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

interface WritableStreamLike {
	write(data: string): boolean;
	end(): void;
}

interface ReadableStreamLike {
	on(event: "data", handler: (chunk: string | Uint8Array) => void): unknown;
	on(event: "error", handler: (error: Error) => void): unknown;
}

interface WorkerProcessLike {
	stdin?: WritableStreamLike;
	stdout?: ReadableStreamLike;
	stderr?: ReadableStreamLike;
	on(event: "error", handler: (error: Error) => void): unknown;
	on(event: "exit", handler: (code: number | null, signal: string | null) => void): unknown;
	kill(signal?: string): boolean;
}

export interface WorkerSupervisorOptions {
	git?: GitRunner;
	spawnWorker?: (command: string, args: string[], options: Record<string, unknown>) => WorkerProcessLike;
	piCommand?: PiCommand;
	worktreeRoot?: string;
	environment?: Record<string, string>;
}

interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: Record<string, unknown>;
	error?: string;
}

interface RpcCommand {
	type: string;
	[key: string]: unknown;
}

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
}

interface PreparedWorktree {
	task: WorkerTaskDefinition;
	taskId: string;
	branch: string;
	worktree: string;
}

interface WorkerHandle {
	state: WorkerTaskState;
	process: WorkerProcessLike;
	rpc: JsonlRpcClient;
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

export class RpcWorkerError extends WorkerSupervisorError {
	constructor(message: string) {
		super(message);
		this.name = "RpcWorkerError";
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

class JsonlRpcClient {
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventHandlers: Array<(event: Record<string, unknown>) => void> = [];
	private nextRequestId = 0;
	private inputBuffer = "";
	private closed = false;

	private readonly process: WorkerProcessLike;

	constructor(process: WorkerProcessLike) {
		this.process = process;
		if (!process.stdin || !process.stdout) throw new RpcWorkerError("RPC worker did not expose stdin/stdout");
		process.stdout.on("data", (chunk) => this.receive(chunk));
		process.stdout.on("error", (error) => this.fail(error));
		process.on("error", (error) => this.fail(error));
		process.on("exit", (code, signal) => {
			this.fail(new RpcWorkerError(`RPC worker exited before responding (code=${code}, signal=${signal})`));
		});
	}

	onEvent(handler: (event: Record<string, unknown>) => void): void {
		this.eventHandlers.push(handler);
	}

	request(command: RpcCommand): Promise<RpcResponse> {
		if (this.closed) return Promise.reject(new RpcWorkerError("RPC worker is closed"));
		const id = `delegate-${++this.nextRequestId}`;
		const request = { ...command, id };
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.process.stdin!.write(`${JSON.stringify(request)}\n`);
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(): void {
		this.closed = true;
		this.fail(new RpcWorkerError("RPC worker closed"));
	}

	private receive(chunk: string | Uint8Array): void {
		this.inputBuffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		while (true) {
			const newline = this.inputBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.inputBuffer.slice(0, newline).replace(/\r$/, "");
			this.inputBuffer = this.inputBuffer.slice(newline + 1);
			if (!line) continue;
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line) as Record<string, unknown>;
			} catch {
				this.eventHandlers.forEach((handler) => handler({ type: "malformed", line }));
				continue;
			}
			if (event.type === "response" && typeof event.id === "string") {
				const pending = this.pending.get(event.id);
				if (pending) {
					this.pending.delete(event.id);
					const response = event as unknown as RpcResponse;
					if (response.success) pending.resolve(response);
					else pending.reject(new RpcWorkerError(response.error ?? `RPC ${response.command} failed`));
					continue;
				}
			}
			this.eventHandlers.forEach((handler) => handler(event));
		}
	}

	private fail(error: Error): void {
		if (this.closed && this.pending.size === 0) return;
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

export class WorkerSupervisor {
	private readonly git: GitRunner;
	private readonly spawnWorker: NonNullable<WorkerSupervisorOptions["spawnWorker"]>;
	private readonly piCommand: PiCommand;
	private readonly worktreeRoot?: string;
	private readonly environment: Record<string, string>;
	private readonly workers = new Map<string, WorkerHandle>();

	constructor(options: WorkerSupervisorOptions = {}) {
		this.git = options.git ?? new DefaultGitRunner();
		this.spawnWorker = options.spawnWorker ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions as never) as unknown as WorkerProcessLike);
		this.piCommand = options.piCommand ?? detectPiCommand();
		this.worktreeRoot = options.worktreeRoot;
		this.environment = options.environment ?? {};
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
			for (const worker of started) await this.stopWorker(worker);
			await this.rollbackWorktrees(repository.root, prepared);
			throw error;
		}
	}

	list(): WorkerTaskState[] {
		return [...this.workers.values()].map((worker) => ({ ...worker.state }));
	}

	async dispose(): Promise<void> {
		const workers = [...this.workers.values()];
		this.workers.clear();
		await Promise.all(workers.map((worker) => this.stopWorker(worker)));
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
		const root = resolve(this.worktreeRoot ?? join(dirname(repository.root), `.${basename(repository.root)}-delegate-worktrees`));
		await mkdir(root, { recursive: true });
		const prepared: PreparedWorktree[] = [];
		try {
			for (const task of tasks) {
				const taskId = `task-${randomUUID()}`;
				const branch = `subagent/${taskId}`;
				const worktree = join(root, taskId);
				const result = await this.git.run(["worktree", "add", "-b", branch, worktree, repository.revision], repository.root);
				if (result.exitCode !== 0) throw new GitCommandError(["worktree", "add", "-b", branch, worktree, repository.revision], result);
				prepared.push({ task, taskId, branch, worktree });
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
		};
		const handle: WorkerHandle = { state, process: child, rpc };
		child.on("exit", (code, signal) => {
			state.exitCode = code;
			state.exitSignal = signal;
			if (state.status === "starting" || state.status === "running") state.status = code === 0 ? "exited" : "failed";
		});
		child.on("error", (error) => {
			state.status = "failed";
			state.error = error.message;
		});
		rpc.onEvent((event) => {
			if (event.type === "malformed") state.error = `Malformed RPC output: ${String(event.line)}`;
		});
		child.stderr?.on("data", (chunk) => {
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			state.error = text.trim() || state.error;
		});

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
			state.status = "running";
			return handle;
		} catch (error) {
			state.status = "failed";
			state.error = error instanceof Error ? error.message : String(error);
			await this.stopWorker(handle);
			throw error;
		}
	}

	private async stopWorker(worker: WorkerHandle): Promise<void> {
		worker.rpc.close();
		if (worker.state.status === "starting" || worker.state.status === "running") worker.state.status = "exited";
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

	private async rollbackWorktrees(repositoryRoot: string, prepared: PreparedWorktree[]): Promise<void> {
		for (const worktree of [...prepared].reverse()) {
			await this.git.run(["worktree", "remove", "--force", worktree.worktree], repositoryRoot);
			await this.git.run(["branch", "-D", worktree.branch], repositoryRoot);
		}
	}
}

function validateStartRequest(request: StartWorkersRequest): void {
	if (!request.repositoryCwd) throw new WorkerSupervisorError("A repository cwd is required.");
	if (!request.sessionDir) throw new WorkerSupervisorError("A session directory is required.");
	if (!Array.isArray(request.tasks) || request.tasks.length === 0) throw new WorkerSupervisorError("At least one worker task is required.");
	for (const [index, task] of request.tasks.entries()) {
		if (!task || typeof task.prompt !== "string" || !task.prompt.trim()) throw new WorkerSupervisorError(`Task ${index + 1} must include a non-empty prompt.`);
	}
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
