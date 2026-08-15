import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const logPath = process.env.FAKE_RPC_LOG;
const sessionDirIndex = args.indexOf("--session-dir");
const sessionDir = sessionDirIndex >= 0 ? args[sessionDirIndex + 1] : process.cwd();
let sessionFile;
let sessionName;
let buffer = "";

function log(entry) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function respond(command, data) {
	process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, ...(data === undefined ? {} : { data }) })}\n`);
}

function appendSession(entry) {
	if (sessionFile) appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
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
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "one-at-a-time",
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
					thinkingLevel: "medium",
				});
				break;
			case "prompt":
				respond(command);
				process.stdout.write(`${JSON.stringify({ type: "turn_start", turn: 1 })}\n`);
				break;
			default:
				respond(command);
		}
	}
});
