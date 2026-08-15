import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const logPath = process.env.FAKE_RPC_LOG;
const sessionDirIndex = args.indexOf("--session-dir");
const sessionDir = sessionDirIndex >= 0 ? args[sessionDirIndex + 1] : process.cwd();
let sessionFile;
let sessionName;
let buffer = "";
let inRun = false;
let lastFinalText = null;
let steeringQueue = [];
let followUpQueue = [];
let releaseKind = null;
let steeredText = null;
let steerRun = null;
let abortRun = null;
let messageCount = 0;
let currentSteerQueues = false;

function log(entry) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

function emit(type, extra = {}) {
	process.stdout.write(`${JSON.stringify({ type, ...extra })}\n`);
}

function respond(command, data) {
	process.stdout.write(
		`${JSON.stringify({
			id: command.id,
			type: "response",
			command: command.type,
			success: true,
			...(data === undefined ? {} : { data }),
		})}\n`,
	);
}

function appendSession(entry) {
	if (sessionFile) appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
}

/**
 * Behavior directives parsed from task prompts and follow-up messages.
 * Each directive is a line of the form `@fake:name [value]`:
 * - `@fake:settle <text>`  final report text for this run (default "fake final report")
 * - `@fake:empty-report`     settle without any final report text
 * - `@fake:delay <ms>`       wait before settling
 * - `@fake:hold`             keep the run active until a steer or abort arrives
 * - `@fake:steer-queues`      steering does not end a held run; it stays queued
 * - `@fake:turns <n>`        emit n turn_start events for this run (default 1)
 * - `@fake:abort`            end the run with an aborted stop reason
 * - `@fake:provider-error`   emit a failed auto-retry event at run start
 * - `@fake:malformed`        emit one malformed JSON line at run start
 * - `@fake:stderr <text>`    write text to stderr at run start
 * - `@fake:exit <code>`      exit the process after the run settles
 * - `@fake:exit-startup <code>`  exit before responding to the prompt command
 */
function parseDirectives(message) {
	const directives = {
		settleText: null,
		emptyReport: false,
		delayMs: 0,
		hold: false,
		steerQueues: false,
		turns: 1,
		abort: false,
		providerError: false,
		malformed: false,
		stderr: null,
		exitCode: undefined,
		exitStartupCode: undefined,
	};
	for (const line of String(message).split("\n")) {
		const match = line.match(/^@fake:(\S+)(?:\s+(.*))?$/);
		if (!match) continue;
		const value = match[2] ?? null;
		switch (match[1]) {
			case "settle":
				directives.settleText = value;
				break;
			case "empty-report":
				directives.emptyReport = true;
				break;
			case "delay":
				directives.delayMs = Number(value) || 0;
				break;
			case "hold":
				directives.hold = true;
				break;
			case "steer-queues":
				directives.steerQueues = true;
				break;
			case "turns":
				directives.turns = Number(value) || 1;
				break;
			case "abort":
				directives.abort = true;
				break;
			case "provider-error":
				directives.providerError = true;
				break;
			case "malformed":
				directives.malformed = true;
				break;
			case "stderr":
				directives.stderr = value;
				break;
			case "exit":
				directives.exitCode = Number(value) || 0;
				break;
			case "exit-startup":
				directives.exitStartupCode = Number(value) || 0;
				break;
			default:
				break;
		}
	}
	return directives;
}

function sleep(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function runCycle(message) {
	const directives = parseDirectives(message);
	if (directives.malformed) process.stdout.write('{"type": "malformed", broken\n');
	if (directives.stderr !== null) process.stderr.write(`${directives.stderr}\n`);
	inRun = true;
	currentSteerQueues = directives.steerQueues;
	emit("agent_start");
	for (let i = 0; i < directives.turns; i += 1) emit("turn_start");
	if (directives.providerError) emit("auto_retry_end", { success: false, attempt: 3, finalError: "529 overloaded_error" });
	emit("queue_update", { steering: steeringQueue, followUp: followUpQueue });
	const waitMs = directives.hold ? 60_000 : directives.delayMs;
	if (waitMs > 0) {
		await new Promise((resolvePromise) => {
			const timer = setTimeout(resolvePromise, waitMs);
			abortRun = () => {
				clearTimeout(timer);
				resolvePromise();
			};
			if (directives.hold) steerRun = abortRun; // Only a held run accepts steering.
		});
		abortRun = null;
		steerRun = null;
	}
	inRun = false;
	currentSteerQueues = false;
	const aborted = directives.abort || releaseKind === "abort";
	const steered = releaseKind === "steer";
	const text = aborted || directives.emptyReport ? "" : steered ? steeredText : directives.settleText ?? "fake final report";
	releaseKind = null;
	steeredText = null;
	if (!aborted) lastFinalText = text;
	emit("message_end", { message: { role: "assistant", content: [{ type: "text", text }], stopReason: aborted ? "aborted" : "stop" } });
	emit("turn_end", { message: { role: "assistant" }, toolResults: [] });
	emit("agent_settled");
	if (steered) {
		steeringQueue.shift();
		emit("queue_update", { steering: steeringQueue, followUp: followUpQueue });
	}
	if (directives.exitCode !== undefined) {
		process.exit(directives.exitCode);
		return;
	}
	if (followUpQueue.length > 0) {
		const next = followUpQueue.shift();
		emit("queue_update", { steering: steeringQueue, followUp: followUpQueue });
		await runCycle(next);
	}
}

	log({
		kind: "start",
		args,
		cwd: process.cwd(),
		workerMarker: process.env.PIMONO_DELEGATE_WORKER,
	});

	process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		const command = JSON.parse(line);
		log({ kind: "command", command });
		switch (command.type) {
			case "new_session":
				mkdirSync(sessionDir, { recursive: true });
				sessionFile = join(sessionDir, `fake-${process.pid}.jsonl`);
				writeFileSync(
					sessionFile,
					`${JSON.stringify({
						type: "session",
						version: 3,
						id: `fake-${process.pid}`,
						timestamp: new Date().toISOString(),
						cwd: process.cwd(),
						...(command.parentSession ? { parentSession: command.parentSession } : {}),
					})}\n`,
				);
				respond(command, { cancelled: false });
				break;
			case "set_session_name":
				sessionName = command.name;
				appendSession({ type: "session_info", name: sessionName });
				respond(command);
				break;
			case "get_state":
				respond(command, {
					sessionId: `fake-${process.pid}`,
					sessionFile,
					sessionName,
					isStreaming: inRun,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "one-at-a-time",
					autoCompactionEnabled: true,
					messageCount,
					pendingMessageCount: steeringQueue.length + followUpQueue.length,
					thinkingLevel: "medium",
				});
				break;
			case "get_last_assistant_text":
				respond(command, { text: lastFinalText });
				break;
			case "prompt": {
				const directives = parseDirectives(command.message);
				messageCount += 1;
				if (directives.exitStartupCode !== undefined) {
					process.exit(directives.exitStartupCode);
					break;
				}
				respond(command);
				void runCycle(command.message);
				break;
			}
			case "steer":
				respond(command);
				steeringQueue.push(command.message);
				emit("queue_update", { steering: steeringQueue, followUp: followUpQueue });
				if (inRun && steerRun && !currentSteerQueues) {
					releaseKind = "steer";
					steeredText = command.message;
					steerRun();
				}
				break;
			case "follow_up":
				respond(command);
				followUpQueue.push(command.message);
				emit("queue_update", { steering: steeringQueue, followUp: followUpQueue });
				if (!inRun) {
					followUpQueue.shift();
					emit("queue_update", { steering: steeringQueue, followUp: followUpQueue });
					void runCycle(command.message);
				}
				break;
			case "abort":
				respond(command);
				if (inRun && abortRun) {
					releaseKind = "abort";
					abortRun();
				}
				break;
			default:
				respond(command);
		}
	}
});
