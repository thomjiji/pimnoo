import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdtemp, rm, mkdir, stat, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { applyTaskLimits, isDelegateWorkerProcess, WorkerSupervisor } from "../extensions/delegate/supervisor.ts";
import { fleetListLines, formatLogsText, formatProgressText, formatReportText, formatStatusText, workerReportText } from "../extensions/delegate/format.ts";

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

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
	throw new Error(`Condition not met within ${timeoutMs}ms`);
}

interface Harness {
	repository: string;
	temporary: string;
	sessionDir: string;
	logPath: string;
	parentSession: string;
	supervisor: WorkerSupervisor;
}

async function createHarness(): Promise<Harness> {
	const repository = await createRepository();
	const temporary = await mkdtemp(join(tmpdir(), "pimono-delegate-ctl-"));
	const sessionDir = join(temporary, "sessions");
	const logPath = join(temporary, "rpc-log.jsonl");
	const parentSession = await createParentSession(sessionDir, repository);
	const supervisor = new WorkerSupervisor({
		worktreeRoot: join(temporary, "worktrees"),
		piCommand: { command: process.execPath, args: [fakeWorker] },
		environment: { FAKE_RPC_LOG: logPath },
	});
	return { repository, temporary, sessionDir, logPath, parentSession, supervisor };
}

async function cleanupHarness(harness: Harness): Promise<void> {
	await harness.supervisor.dispose();
	await rm(harness.repository, { recursive: true, force: true });
	await rm(harness.temporary, { recursive: true, force: true });
}

async function startTasks(harness: Harness, tasks: Parameters<WorkerSupervisor["start"]>[0]["tasks"]) {
	return harness.supervisor.start({
		repositoryCwd: harness.repository,
		parentSession: harness.parentSession,
		sessionDir: harness.sessionDir,
		tasks,
	});
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
		// Startup succeeded when the worker is alive and not in a failed or
		// aborted state; a fast worker may already have settled its first run.
		assert.ok(["running", "waiting", "completed"].includes(tasks[0].status), tasks[0].status);
		assert.ok(["running", "waiting", "completed"].includes(tasks[1].status), tasks[1].status);
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

test("steers one running worker without touching the other", async () => {
	const harness = await createHarness();
	try {
		const [alpha, beta] = await startTasks(harness, [
			{ prompt: "@fake:hold\nImplement feature A." },
			{ prompt: "Implement feature B." },
		]);
		await until(() => harness.supervisor.status(alpha.taskId)[0].status === "running");
		await harness.supervisor.steer(alpha.taskId, "Skip feature A; write the report instead.");

		await until(() => harness.supervisor.status(alpha.taskId)[0].status === "completed");
		const log = await readLog(harness.logPath);
		const steerCommands = log.filter((entry) => entry.kind === "command" && entry.command.type === "steer");
		assert.equal(steerCommands.length, 1);
		const alphaStart = log.find((entry) => entry.kind === "start" && entry.cwd === alpha.worktree);
		assert.equal(steerCommands[0].pid, alphaStart.pid);

		const alphaState = harness.supervisor.status(alpha.taskId)[0];
		assert.equal(alphaState.status, "completed");
		assert.match(alphaState.finalText ?? "", /Skip feature A/);
		const betaState = harness.supervisor.status(beta.taskId)[0];
		assert.equal(betaState.status, "completed");
		assert.match(betaState.finalText ?? "", /fake final report/);

		// Steering an idle worker is rejected; follow_up is the right channel.
		await assert.rejects(harness.supervisor.steer(alpha.taskId, "Another steer."), /not running/);
	} finally {
		await cleanupHarness(harness);
	}
});

test("delivers a follow-up after the worker settles and reports the new final text", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:hold\nInitial task." }]);
		await until(() => harness.supervisor.status(worker.taskId)[0].status === "running");
		await harness.supervisor.followUp(worker.taskId, "@fake:settle Follow-up report.");
		await harness.supervisor.steer(worker.taskId, "finish now");

		const states = await harness.supervisor.waitForTerminal();
		assert.equal(states.length, 1);
		assert.equal(states[0].taskId, worker.taskId);
		assert.equal(states[0].status, "completed");
		assert.equal(states[0].finalText, "Follow-up report.");
		assert.equal(states[0].pendingFollowUps, 0);
		assert.equal(states[0].pendingSteering, 0);
	} finally {
		await cleanupHarness(harness);
	}
});

test("reports waiting while a steering message is queued after the run settles", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:delay 400\nLong task." }]);
		await until(() => harness.supervisor.status(worker.taskId)[0].status === "running");
		await harness.supervisor.steer(worker.taskId, "Wrap up soon.");
		await until(() => harness.supervisor.status(worker.taskId)[0].status === "waiting");
		const state = harness.supervisor.status(worker.taskId)[0];
		assert.equal(state.pendingSteering, 1);
	} finally {
		await cleanupHarness(harness);
	}
});

test("status lists one worker or all workers and rejects unknown task ids", async () => {
	const harness = await createHarness();
	try {
		const [alpha, beta] = await startTasks(harness, [
			{ prompt: "@fake:delay 300\nSlow task." },
			{ prompt: "Quick task." },
		]);
		const all = harness.supervisor.status();
		assert.equal(all.length, 2);
		for (const state of all) {
			assert.ok(state.taskId);
			assert.ok(state.worktree);
			assert.ok(state.sessionFile);
			assert.ok(["starting", "running", "waiting", "completed", "failed", "aborted", "stopped"].includes(state.status));
		}
		const single = harness.supervisor.status(alpha.taskId);
		assert.equal(single.length, 1);
		assert.equal(single[0].taskId, alpha.taskId);
		assert.throws(() => harness.supervisor.status("task-unknown"), /No worker with task ID/);
	} finally {
		await cleanupHarness(harness);
	}
});

test("stop terminates the worker but preserves its session file and worktree", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:hold\nEndless task." }]);
		await until(() => harness.supervisor.status(worker.taskId)[0].status === "running");
		const state = await harness.supervisor.stop(worker.taskId);
		assert.equal(state.status, "stopped");
		// The snapshot does not update after the process exits; poll the live state.
		await until(() => harness.supervisor.status(worker.taskId)[0].exitCode !== undefined);

		assert.equal((await stat(worker.sessionFile)).isFile(), true);
		assert.equal((await stat(worker.worktree)).isDirectory(), true);
		const branches = await git(harness.repository, "branch", "--list", "subagent/*");
		assert.match(branches.stdout, new RegExp(worker.branch));
	} finally {
		await cleanupHarness(harness);
	}
});

test("marks a worker failed when the RPC stream emits malformed output", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:malformed\nDo work." }]);
		const states = await harness.supervisor.waitForTerminal([worker.taskId]);
		assert.equal(states[0].status, "failed");
		assert.match(states[0].error ?? "", /Malformed RPC output/);
	} finally {
		await cleanupHarness(harness);
	}
});

test("marks a worker failed when the process exits non-zero and rejects follow-ups", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:exit 3\nDoomed task." }]);
		const states = await harness.supervisor.waitForTerminal([worker.taskId]);
		assert.equal(states[0].status, "failed");
		assert.equal(states[0].exitCode, 3);
		await assert.rejects(harness.supervisor.followUp(worker.taskId, "Try again."), /cannot accept follow-up/);
	} finally {
		await cleanupHarness(harness);
	}
});

test("marks a worker aborted when its run ends with an aborted stop reason", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:abort\nInterrupted task." }]);
		const states = await harness.supervisor.waitForTerminal([worker.taskId]);
		assert.equal(states[0].status, "aborted");
		await assert.rejects(harness.supervisor.followUp(worker.taskId, "Continue anyway."), /cannot accept follow-up/);
		const stopped = await harness.supervisor.stop(worker.taskId);
		assert.equal(stopped.status, "stopped");
	} finally {
		await cleanupHarness(harness);
	}
});

test("rolls back a failed batch startup and removes orphan session files", async () => {
	const harness = await createHarness();
	try {
		await assert.rejects(
			startTasks(harness, [
				{ prompt: "First task." },
				{ prompt: "@fake:exit-startup 7\nSecond task." },
			]),
			/exited before responding|exited before startup/,
		);
		const worktrees = (await git(harness.repository, "worktree", "list", "--porcelain")).stdout;
		assert.equal(worktrees.split("worktree ").length, 2);
		const branches = await git(harness.repository, "branch", "--list", "subagent/*");
		assert.equal(branches.stdout.trim(), "");
		const sessionFiles = await readdir(harness.sessionDir);
		assert.deepEqual(sessionFiles.filter((name) => name.startsWith("fake-")), []);
	} finally {
		await cleanupHarness(harness);
	}
});

test("waitForTerminal associates concurrent final reports with the right task ids", async () => {
	const harness = await createHarness();
	try {
		const [alpha, beta, gamma] = await startTasks(harness, [
			{ prompt: "@fake:settle Alpha report." },
			{ prompt: "@fake:delay 250\n@fake:settle Beta report." },
			{ prompt: "@fake:hold\nGamma keeps working." },
		]);
		const results = await harness.supervisor.waitForTerminal([alpha.taskId, beta.taskId]);
		assert.equal(results.length, 2);
		const byId = new Map(results.map((state) => [state.taskId, state]));
		assert.equal(byId.get(alpha.taskId).status, "completed");
		assert.equal(byId.get(alpha.taskId).finalText, "Alpha report.");
		assert.equal(byId.get(beta.taskId).status, "completed");
		assert.equal(byId.get(beta.taskId).finalText, "Beta report.");
		assert.equal(harness.supervisor.status(gamma.taskId)[0].status, "running");
		const stopped = await harness.supervisor.stop(gamma.taskId);
		assert.equal(stopped.status, "stopped");
	} finally {
		await cleanupHarness(harness);
	}
});

test("notifies state changes for TUI status surfaces", async () => {
	const harness = await createHarness();
	try {
		let changes = 0;
		const supervisor = new WorkerSupervisor({
			worktreeRoot: join(harness.temporary, "worktrees-observed"),
			piCommand: { command: process.execPath, args: [fakeWorker] },
			environment: { FAKE_RPC_LOG: harness.logPath },
			onStateChange: () => {
				changes += 1;
			},
		});
		try {
			await supervisor.start({
				repositoryCwd: harness.repository,
				parentSession: harness.parentSession,
				sessionDir: harness.sessionDir,
				tasks: [{ prompt: "Observed task." }],
			});
			assert.ok(changes > 0, `expected state changes, got ${changes}`);
		} finally {
			await supervisor.dispose();
		}
	} finally {
		await cleanupHarness(harness);
	}
});

test("formats bounded, task-scoped tool results", () => {
	const base = {
		branch: "subagent/task-1",
		cwd: "/tmp/wt-1",
		sessionName: "subagent/one",
		turns: 2,
		pendingSteering: 0,
		pendingFollowUps: 0,
		status: "completed",
	} as const;
	const states = [
		{
			...base,
			taskId: "task-1",
			worktree: "/tmp/wt-1",
			sessionFile: "/sessions/one.jsonl",
			finalText: "x".repeat(5000),
		},
		{
			...base,
			taskId: "task-2",
			worktree: "/tmp/wt-2",
			sessionFile: "/sessions/two.jsonl",
			status: "running",
			turns: 4,
			lastTool: "bash",
		},
	];

	const status = formatStatusText(states);
	assert.match(status, /task-1: completed, turn 2/);
	assert.match(status, /task-2: running, turn 4, tool bash/);
	assert.match(status, /worktree: \/tmp\/wt-2/);
	assert.match(status, /session: \/sessions\/two\.jsonl/);

	const report = formatReportText(states);
	assert.match(report, /task-1 \(subagent\/one\): completed/);
	assert.match(report, /final: x{500}.+\.\.\.$/m);
	assert.equal(report.includes("x".repeat(2001)), false);

});

test("stop terminates a completed worker's process", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "Quick task." }]);
		await until(() => harness.supervisor.status(worker.taskId)[0].status === "completed");
		const state = await harness.supervisor.stop(worker.taskId);
		assert.equal(state.status, "stopped");
		await until(() => harness.supervisor.status(worker.taskId)[0].exitCode !== undefined);
		assert.equal((await stat(worker.sessionFile)).isFile(), true);
	} finally {
		await cleanupHarness(harness);
	}
});

test("sends a wrap-up steering message at the soft threshold and enters wrapping up", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:turns 2\n@fake:steer-queues\n@fake:hold\nWork.", maxTurns: 3, softTurnThreshold: 2 }]);
		await until(() => harness.supervisor.status(worker.taskId)[0].status === "wrapping up");
		const state = harness.supervisor.status(worker.taskId)[0];
		assert.equal(state.turns, 2);
		const log = await readLog(harness.logPath);
		const steers = log.filter((entry) => entry.kind === "command" && entry.command.type === "steer");
		assert.equal(steers.length, 1);
		assert.match(steers[0].command.message, /final report/);
		const stopped = await harness.supervisor.stop(worker.taskId);
		assert.equal(stopped.status, "stopped");
	} finally {
		await cleanupHarness(harness);
	}
});

test("aborts at the hard turn limit after the grace period and records limit-reached", async () => {
	const harness = await createHarness();
	try {
		const supervisor = new WorkerSupervisor({
			worktreeRoot: join(harness.temporary, "worktrees-hard"),
			piCommand: { command: process.execPath, args: [fakeWorker] },
			environment: { FAKE_RPC_LOG: harness.logPath },
			graceMs: 200,
		});
		try {
			const [worker] = await supervisor.start({
				repositoryCwd: harness.repository,
				parentSession: harness.parentSession,
				sessionDir: harness.sessionDir,
				tasks: [{ prompt: "@fake:turns 5\n@fake:steer-queues\n@fake:hold\nWork.", maxTurns: 3, softTurnThreshold: 2 }],
			});
			await until(() => supervisor.status(worker.taskId)[0].status === "limit-reached");
			const state = supervisor.status(worker.taskId)[0];
			assert.equal(state.turns, 5);
			assert.match(state.error ?? "", /Turn limit reached after 5 turns/);
			await until(() => supervisor.status(worker.taskId)[0].exitCode !== undefined);
			assert.equal((await stat(worker.sessionFile)).isFile(), true);
			assert.equal((await stat(worker.worktree)).isDirectory(), true);
		} finally {
			await supervisor.dispose();
		}
	} finally {
		await cleanupHarness(harness);
	}
});

test("terminates a worker that exceeds its total timeout and marks it timed-out", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:hold\nWork.", timeoutMs: 200 }]);
		await until(() => harness.supervisor.status(worker.taskId)[0].status === "timed-out");
		const state = harness.supervisor.status(worker.taskId)[0];
		assert.match(state.error ?? "", /Timed out after 200ms/);
		await until(() => harness.supervisor.status(worker.taskId)[0].exitCode !== undefined);
		assert.equal((await stat(worker.sessionFile)).isFile(), true);
	} finally {
		await cleanupHarness(harness);
	}
});

test("parent cancellation of a wait stops the waited workers but not others", async () => {
	const harness = await createHarness();
	try {
		const [alpha, beta] = await startTasks(harness, [
			{ prompt: "@fake:hold\nAlpha work." },
			{ prompt: "@fake:hold\nBeta work." },
		]);
		await until(() => harness.supervisor.status(alpha.taskId)[0].status === "running");
		await until(() => harness.supervisor.status(beta.taskId)[0].status === "running");
		const controller = new AbortController();
		const waiting = harness.supervisor.waitForTerminal([alpha.taskId], controller.signal);
		controller.abort();
		const states = await waiting;
		assert.equal(states.length, 1);
		assert.equal(states[0].status, "stopped");
		assert.equal(harness.supervisor.status(beta.taskId)[0].status, "running");
	} finally {
		await cleanupHarness(harness);
	}
});

test("classifies provider errors as failed with the provider message", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:provider-error\nWork." }]);
		const states = await harness.supervisor.waitForTerminal([worker.taskId]);
		assert.equal(states[0].status, "failed");
		assert.match(states[0].error ?? "", /Provider error: .*overloaded_error/);
	} finally {
		await cleanupHarness(harness);
	}
});

test("flags a completed worker without a final report", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:empty-report\nWork." }]);
		const states = await harness.supervisor.waitForTerminal([worker.taskId]);
		assert.equal(states[0].status, "completed");
		assert.match(states[0].error ?? "", /without a final report/);
	} finally {
		await cleanupHarness(harness);
	}
});

test("captures stderr as diagnostics without failing the worker", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:stderr warning: disk almost full\nWork." }]);
		const states = await harness.supervisor.waitForTerminal([worker.taskId]);
		assert.equal(states[0].status, "completed");
		assert.equal(states[0].error, undefined);
		assert.match(states[0].diagnostics ?? "", /warning: disk almost full/);
	} finally {
		await cleanupHarness(harness);
	}
});

test("validates turn limits before creating any worktree", async () => {
	const harness = await createHarness();
	try {
		await assert.rejects(
			startTasks(harness, [{ prompt: "Work.", maxTurns: 0 }]),
			/maxTurns must be a positive integer/,
		);
		await assert.rejects(
			startTasks(harness, [{ prompt: "Work.", maxTurns: 3, softTurnThreshold: 3 }]),
			/softTurnThreshold must be a positive integer below maxTurns/,
		);
		await assert.rejects(
			startTasks(harness, [{ prompt: "Work.", timeoutMs: -5 }]),
			/timeoutMs must be a positive integer/,
		);
		const worktrees = (await git(harness.repository, "worktree", "list", "--porcelain")).stdout;
		assert.equal(worktrees.split("worktree ").length, 2);
	} finally {
		await cleanupHarness(harness);
	}
});

test("re-arms the hard-limit grace when a revived worker is already past the limit", async () => {
	const harness = await createHarness();
	try {
		const supervisor = new WorkerSupervisor({
			worktreeRoot: join(harness.temporary, "worktrees-rearm"),
			piCommand: { command: process.execPath, args: [fakeWorker] },
			environment: { FAKE_RPC_LOG: harness.logPath },
			graceMs: 200,
		});
		try {
			const [worker] = await supervisor.start({
				repositoryCwd: harness.repository,
				parentSession: harness.parentSession,
				sessionDir: harness.sessionDir,
				tasks: [{ prompt: "@fake:turns 4\nWork.", maxTurns: 3, softTurnThreshold: 2 }],
			});
			await until(() => supervisor.status(worker.taskId)[0].status === "completed");
			await supervisor.followUp(worker.taskId, "@fake:hold\nKeep going.");
			await until(() => supervisor.status(worker.taskId)[0].status === "limit-reached");
			const state = supervisor.status(worker.taskId)[0];
			assert.match(state.error ?? "", /Turn limit reached after/);
			assert.equal((await stat(worker.sessionFile)).isFile(), true);
		} finally {
			await supervisor.dispose();
		}
	} finally {
		await cleanupHarness(harness);
	}
});

test("wait cancellation terminates a worker whose abort response hangs, within a bounded time", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:hang-abort\n@fake:hold\nWork." }]);
		await until(() => harness.supervisor.status(worker.taskId)[0].status === "running");
		const controller = new AbortController();
		const startedAt = Date.now();
		const waiting = harness.supervisor.waitForTerminal([worker.taskId], controller.signal);
		controller.abort();
		const states = await waiting;
		const elapsed = Date.now() - startedAt;
		assert.equal(states[0].status, "stopped");
		assert.ok(elapsed < 5000, `cancellation took ${elapsed}ms, expected a bounded stop`);
		await until(() => harness.supervisor.status(worker.taskId)[0].exitCode !== undefined);
		assert.equal((await stat(worker.sessionFile)).isFile(), true);
	} finally {
		await cleanupHarness(harness);
	}
});

test("applyTaskLimits fills missing task limits from top-level defaults", () => {
	const defaults = { maxTurns: 10, softTurnThreshold: 8, timeoutMs: 5000 };
	const tasks = [
		{ prompt: "a" },
		{ prompt: "b", maxTurns: 20 },
		{ prompt: "c", timeoutMs: 999 },
	];
	const merged = applyTaskLimits(tasks, defaults);
	assert.equal(merged[0].maxTurns, 10);
	assert.equal(merged[0].softTurnThreshold, 8);
	assert.equal(merged[0].timeoutMs, 5000);
	assert.equal(merged[1].maxTurns, 20);
	assert.equal(merged[1].softTurnThreshold, 8);
	assert.equal(merged[1].timeoutMs, 5000);
	assert.equal(merged[2].maxTurns, 10);
	assert.equal(merged[2].timeoutMs, 999);
	assert.deepEqual(applyTaskLimits(tasks, {}), tasks);
});

test("records a bounded activity tail and serves it through logs", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:settle Log report.\nWork." }]);
		await until(() => harness.supervisor.status(worker.taskId)[0].status === "completed");
		const logs = harness.supervisor.logs(worker.taskId);
		assert.ok(logs.some((line) => line.includes("turn 1 started")), logs.join("|"));
		assert.ok(logs.some((line) => line.includes("assistant: Log report.")), logs.join("|"));
		assert.ok(logs.some((line) => line.includes("run settled")), logs.join("|"));
		const state = harness.supervisor.status(worker.taskId)[0];
		assert.ok((state.elapsedMs ?? 0) > 0);
		assert.ok(Array.isArray(state.activity) && state.activity.length > 0);
		assert.throws(() => harness.supervisor.logs("task-unknown"), /No worker with task ID/);
	} finally {
		await cleanupHarness(harness);
	}
});

test("records tool activity with bounded lines and reports tool durations", async () => {
	const harness = await createHarness();
	try {
		const [worker] = await startTasks(harness, [{ prompt: "@fake:settle Done.\nWork." }]);
		const progress: string[] = [];
		const states = await harness.supervisor.waitForTerminal([worker.taskId], undefined, (snapshot) => {
			progress.push(snapshot[0]?.taskId ?? "");
		});
		assert.equal(states[0].status, "completed");
		assert.ok(progress.length >= 1, "progress callback should fire at least once");
		assert.ok(progress.every((id) => id === worker.taskId));
	} finally {
		await cleanupHarness(harness);
	}
});

test("formats progress, logs, and widget lines for the TUI surfaces", () => {
	const running = {
		taskId: "task-run",
		branch: "subagent/task-run",
		cwd: "/tmp/wt-run",
		sessionName: "subagent/runner",
		turns: 3,
		pendingSteering: 0,
		pendingFollowUps: 0,
		status: "running",
		worktree: "/tmp/wt-run",
		sessionFile: "/sessions/run.jsonl",
		lastTool: "bash",
		toolElapsedMs: 45_000,
		elapsedMs: 252_000,
		activity: ["10:00:01 turn 3 started", "10:00:02 tool bash started: {\"command\":\"sleep 25\"}"],
	} as const;
	const done = {
		...running,
		taskId: "task-done",
		sessionName: "subagent/finished",
		status: "completed",
		lastTool: undefined,
		toolElapsedMs: 0,
	} as const;

	const progress = formatProgressText([running]);
	assert.match(progress, /task-run \(subagent\/runner\): running/);
	assert.match(progress, /turn 3/);
	assert.match(progress, /bash 45s/);
	assert.match(progress, /elapsed 4m12s/);

	const logs = formatLogsText(running);
	assert.match(logs, /task-run \(subagent\/runner\): running/);
	assert.match(logs, /tool bash started/);
	assert.equal(formatLogsText({ ...running, activity: [] }), "task-run (subagent/runner): running\n  (no activity recorded)");
});

test("renders fleet list rows with selection and expansion", () => {
	const base = {
		branch: "subagent/task-1",
		cwd: "/tmp/wt-1",
		sessionName: "subagent/one",
		turns: 3,
		pendingSteering: 0,
		pendingFollowUps: 0,
		worktree: "/tmp/wt-1",
		sessionFile: "/sessions/one.jsonl",
		lastTool: "bash",
		toolElapsedMs: 12_000,
	} as const;
	const alpha = { ...base, taskId: "task-a", status: "running", elapsedMs: 240_000, activity: ["10:00:01 turn 3 started", "10:00:02 tool bash started"] };
	const beta = { ...base, taskId: "task-b", sessionName: "subagent/two", status: "waiting", lastTool: undefined, toolElapsedMs: 0, elapsedMs: 60_000, activity: ["10:00:03 run settled"] };
	const done = { ...base, taskId: "task-c", sessionName: "subagent/three", status: "completed", elapsedMs: 10_000, activity: [] };

	const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
	const lines = fleetListLines([alpha, beta, done]);
	assert.equal(stripAnsi(lines[0]), "delegate: 2 active workers");
	assert.equal(stripAnsi(lines[1]), "├─ subagent/one: running · turn 3 · bash 12s · 4m00s");
	assert.equal(stripAnsi(lines[2]), "└─ subagent/two: waiting · turn 3 · 1m00s");
	assert.equal(lines.includes("subagent/three"), false);

	// Windowed: with seven workers only five rows render, plus a more indicator.
	const many = Array.from({ length: 7 }, (_, i) => ({ ...alpha, taskId: `task-${i}`, elapsedMs: 240_000 - i * 1000 }));
	const windowed = fleetListLines(many);
	assert.equal(windowed.length, 7);
	assert.match(stripAnsi(windowed[windowed.length - 1]), /└─ ↓ 2 more/);
});

test("renders worker completion reports for the main transcript", () => {
	const theme = { bold: (text: string) => `B(${text})`, fg: (name: string, text: string) => `${name}(${text})` };
	const ok = workerReportText(
		{ taskId: "task-a", sessionName: "subagent/a", status: "completed", turns: 3, elapsedMs: 65_000, finalText: "First line.\nSecond line.", sessionFile: "/sessions/a.jsonl" },
		theme,
	);
	assert.match(ok, /success\(ok\) B\(subagent\/a\) dim\(completed\)/);
	assert.match(ok, /dim\(turn 3 · 1m05s\)/);
	assert.match(ok, /dim\(-> First line\.\)/);
	assert.match(ok, /dim\(session: \/sessions\/a\.jsonl\)/);

	const failed = workerReportText(
		{ taskId: "task-b", sessionName: "subagent/b", status: "failed", turns: 1, elapsedMs: 2000, error: "RPC worker exited with code 3", sessionFile: "/sessions/b.jsonl" },
		theme,
	);
	assert.match(failed, /error\(fail\) B\(subagent\/b\) dim\(failed\)/);
	assert.match(failed, /error\(- RPC worker exited with code 3\)/);
});

test("fleet list renders themed widget lines, lingers finished workers, and clears on dispose", async () => {
	const { FleetList } = await import("../extensions/delegate/fleet-list.ts");
	const rendered: string[][] = [];
	let cleared = 0;
	const fakeTheme = { bold: (text: string) => `B(${text})`, fg: (name: string, text: string) => `${name}(${text})` };
	let factory: ((tui: unknown, theme: typeof fakeTheme) => { render(): string[] }) | undefined;
	const ui = {
		setWidget(_key: string, content: undefined | typeof factory) {
			if (content === undefined) {
				cleared += 1;
				factory = undefined;
			} else {
				factory = content;
			}
		},
	};
	let states: Array<{ taskId: string; sessionName: string; status: string; turns: number; lastTool?: string; toolElapsedMs?: number; elapsedMs?: number; completedAt?: number }> = [];
	const fleet = new FleetList(() => states as never, { lingerMs: 60, tickMs: 50 });
	try {
		states = [
			{ taskId: "task-a", sessionName: "subagent/a", status: "running", turns: 2, lastTool: "bash", toolElapsedMs: 3000, elapsedMs: 20000 },
		];
		fleet.update(ui, states as never);
		assert.ok(factory, "widget factory should be registered");
		rendered.push(factory?.({}, fakeTheme)?.render() ?? []);
		assert.equal(rendered.at(-1)?.[0], "B(delegate: 1 active worker)");
		assert.equal(rendered.at(-1)?.[1], "dim(└─ subagent/a: running · turn 2 · bash 3s · 20s)");

		// Finished workers linger briefly before dropping out.
		states = [
			{ taskId: "task-a", sessionName: "subagent/a", status: "completed", turns: 2, elapsedMs: 21000, completedAt: Date.now() },
		];
		fleet.update(ui, states as never);
		rendered.push(factory?.({}, fakeTheme)?.render() ?? []);
		assert.match(rendered.at(-1)?.[1] ?? "", /subagent\/a: completed/);

		await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
		fleet.update(ui, states as never);
		assert.ok(cleared >= 1, "widget should clear once the linger window passes");
	} finally {
		fleet.dispose();
	}
});
