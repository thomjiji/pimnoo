import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isDelegateWorkerProcess, WorkerSupervisor } from "../extensions/delegate/supervisor.ts";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fakeWorker = join(root, "test", "fixtures", "fake-rpc-worker.mjs");

async function git(cwd: string, ...args: string[]) {
	return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function createRepository() {
	const directory = await mkdtemp(join(tmpdir(), "pimono-delegate-repo-"));
	await git(directory, "init", "-q");
	await git(directory, "config", "user.email", "delegate-test@example.invalid");
	await git(directory, "config", "user.name", "delegate test");
	await writeFile(join(directory, "README.md"), "delegate fixture\n");
	await git(directory, "add", "README.md");
	await git(directory, "commit", "-qm", "fixture");
	return directory;
}

async function createParentSession(sessionDir: string, cwd: string) {
	await mkdir(sessionDir, { recursive: true });
	const path = join(sessionDir, "parent.jsonl");
	await writeFile(
		path,
		`${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd })}\n`,
	);
	return path;
}

async function readLog(path: string) {
	const content = await readFile(path, "utf8");
	return content
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("starts multiple isolated RPC workers with persistent child sessions", async () => {
	const repository = await createRepository();
	const temporary = await mkdtemp(join(tmpdir(), "pimono-delegate-test-"));
	const sessionDir = join(temporary, "sessions");
	const logPath = join(temporary, "rpc-log.jsonl");
	const parentSession = await createParentSession(sessionDir, repository);
	const supervisor = new WorkerSupervisor({
		worktreeRoot: join(temporary, "worktrees"),
		piCommand: { command: process.execPath, args: [fakeWorker] },
		environment: { FAKE_RPC_LOG: logPath },
	});

	try {
		const tasks = await supervisor.start({
			repositoryCwd: repository,
			parentSession,
			sessionDir,
			parentModel: "openai/gpt-test",
			thinkingLevel: "high",
			tasks: [
				{ name: "implementer", role: "implementer", prompt: "Implement the first task." },
				{ name: "reviewer", role: "reviewer", model: "anthropic/review-model", thinkingLevel: "low", prompt: "Review the second task." },
			],
		});

		assert.equal(tasks.length, 2);
		assert.notEqual(tasks[0].taskId, tasks[1].taskId);
		assert.notEqual(tasks[0].worktree, tasks[1].worktree);
		assert.match(tasks[0].branch, /^subagent\//);
		assert.match(tasks[1].branch, /^subagent\//);
		assert.equal(tasks[0].status, "running");
		assert.equal(tasks[1].status, "running");
		assert.ok(tasks[0].sessionFile);
		assert.ok(tasks[1].sessionFile);
		assert.equal((await git(tasks[0].worktree, "rev-parse", "--show-toplevel")).stdout.trim(), tasks[0].worktree);
		assert.equal((await git(tasks[1].worktree, "rev-parse", "--show-toplevel")).stdout.trim(), tasks[1].worktree);

		const log = await readLog(logPath);
		const starts = log.filter((entry) => entry.kind === "start");
		assert.equal(starts.length, 2);
		for (const start of starts) {
			assert.equal(start.workerMarker, "1");
			assert.equal(isDelegateWorkerProcess({ PIMONO_DELEGATE_WORKER: start.workerMarker }), true);
			assert.equal(start.cwd.startsWith(join(temporary, "worktrees")), true);
			assert.equal(start.args.includes("--mode") && start.args.includes("rpc"), true);
			assert.equal(start.args.includes("--no-session"), false);
			assert.equal(start.args.includes("--tools") && start.args.includes("read,bash,edit,write,grep,find,ls"), true);
			assert.equal(start.args.includes("--exclude-tools") && start.args.includes("delegate"), true);
			assert.equal(start.args.includes("--session-dir"), true);
			assert.equal(start.args.includes("--append-system-prompt"), true);
		}
		assert.equal(isDelegateWorkerProcess({}), false);
		const implementerStart = starts.find((start) => start.cwd === tasks[0].worktree);
		const reviewerStart = starts.find((start) => start.cwd === tasks[1].worktree);
		assert.ok(implementerStart);
		assert.ok(reviewerStart);
		assert.equal(implementerStart.args.includes("openai/gpt-test"), true);
		assert.equal(implementerStart.args.includes("high"), true);
		assert.equal(reviewerStart.args.includes("anthropic/review-model"), true);
		assert.equal(reviewerStart.args.includes("low"), true);

		const prompts = log.filter((entry) => entry.kind === "command" && entry.command.type === "prompt");
		assert.equal(prompts.length, 2);
		assert.equal(prompts.some((entry) => entry.command.message.includes("Implement the first task.")), true);
		assert.equal(prompts.some((entry) => entry.command.message.includes("Review the second task.")), true);

		const sessionHeaders = await Promise.all(tasks.map((task) => readFile(task.sessionFile!, "utf8")));
		for (const [index, content] of sessionHeaders.entries()) {
			const entries = content.trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(entries[0].type, "session");
			assert.equal(entries[0].cwd, tasks[index].worktree);
			assert.equal(entries[0].parentSession, parentSession);
			assert.equal(entries.some((entry) => entry.type === "session_info" && entry.name.startsWith("subagent/")), true);
		}
	} finally {
		await supervisor.dispose();
		await rm(repository, { recursive: true, force: true });
		await rm(temporary, { recursive: true, force: true });
	}
});

test("rejects a dirty parent before creating any worktree or worker", async () => {
	const repository = await createRepository();
	const temporary = await mkdtemp(join(tmpdir(), "pimono-delegate-dirty-"));
	const sessionDir = join(temporary, "sessions");
	const logPath = join(temporary, "rpc-log.jsonl");
	await writeFile(join(repository, "README.md"), "uncommitted change\n");
	const supervisor = new WorkerSupervisor({
		worktreeRoot: join(temporary, "worktrees"),
		piCommand: { command: process.execPath, args: [fakeWorker] },
		environment: { FAKE_RPC_LOG: logPath },
	});

	try {
		await assert.rejects(
			supervisor.start({
				repositoryCwd: repository,
				sessionDir,
				tasks: [{ prompt: "This must not start." }],
			}),
			/dirty/i,
		);
		await assert.rejects(readFile(logPath, "utf8"), /ENOENT/);
		assert.equal((await git(repository, "worktree", "list", "--porcelain")).stdout.split("worktree ").length, 2);
	} finally {
		await supervisor.dispose();
		await rm(repository, { recursive: true, force: true });
		await rm(temporary, { recursive: true, force: true });
	}
});
