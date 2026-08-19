import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRootPattern = root.replaceAll("\\", "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PI_BIN = process.env.PI_BIN;
if (!PI_BIN) {
	throw new Error("Package smoke tests require an explicit Pi CLI path. Set PI_BIN to a trusted local Pi executable.");
}
const piEnv = {
	...process.env,
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
	GIT_TERMINAL_PROMPT: "0",
};

function run(command, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		execFile(command, args, { ...options, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				error.stdout = stdout;
				error.stderr = stderr;
				reject(error);
				return;
			}
			resolvePromise({ stdout, stderr });
		});
	});
}

function runRpc(agentDir, projectDir, lines, extraArgs = []) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(PI_BIN, ["--mode", "rpc", "--no-session", "--no-approve", ...extraArgs], {
			cwd: projectDir,
			env: { ...piEnv, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`RPC smoke test timed out. stderr:\n${stderr}`));
		}, 20_000);
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			const lines = stdout
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return { type: "unparsed", line };
					}
				});
			resolvePromise({ code: code ?? 1, signal, lines, stdout, stderr });
		});
		child.stdin.end(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	});
}

function response(lines, id) {
	return lines.find((line) => line.type === "response" && line.id === id);
}

function startOpenAiFixtureServer() {
	const requests = [];
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body);
			requests.push(payload);
			const model = payload.model;
			if (model === "deepseek-v4-flash") {
				response.writeHead(500, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "fixture failure" } }));
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			const text = JSON.stringify(payload.messages).includes("<conversation>")
				? "FIXTURE TITLE!!!"
				: "fixture assistant response";
			response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	return { server, requests };
}

async function runRpcUntilSessionNamed(agentDir, projectDir, extraArgs, prompt) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(PI_BIN, ["--mode", "rpc", "--model", "fixture/title", "--no-approve", ...extraArgs], {
			cwd: projectDir,
			env: { ...piEnv, PI_OFFLINE: "1", PI_AUTOTITLE_MODEL: "", PI_CODING_AGENT_DIR: agentDir },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const lines = [];
		let pending = "";
		let stderr = "";
		let stateRequested = false;
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`auto-title smoke test timed out. stderr:\n${stderr}`));
		}, 20_000);
		child.stdout.on("data", (chunk) => {
			pending += chunk;
			for (;;) {
				const newline = pending.indexOf("\n");
				if (newline < 0) break;
				const text = pending.slice(0, newline).trim();
				pending = pending.slice(newline + 1);
				if (!text) continue;
				try {
					const line = JSON.parse(text);
					lines.push(line);
					if (line.type === "session_info_changed" && !stateRequested) {
						stateRequested = true;
						child.stdin.write(JSON.stringify({ id: "state", type: "get_state" }) + "\n");
					}
					if (line.type === "response" && line.id === "state") {
						clearTimeout(timer);
						setTimeout(() => child.kill("SIGTERM"), 100);
					}
				} catch {
					lines.push({ type: "unparsed", text });
				}
			}
		});
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolvePromise({ code: code ?? 1, signal, lines, stderr });
		});
		child.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: prompt }) + "\n");
	});
}

function commandList(rpcResult) {
	const result = response(rpcResult.lines, "commands");
	assert.equal(result?.success, true, `get_commands failed:\n${rpcResult.stderr}\n${rpcResult.stdout}`);
	return result.data.commands;
}

async function startGitHttpServer(projectRoot) {
	const server = http.createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
		const child = spawn("git", ["http-backend"], {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: projectRoot,
				GIT_HTTP_EXPORT_ALL: "1",
				PATH_INFO: requestUrl.pathname,
				QUERY_STRING: requestUrl.search.slice(1),
				REQUEST_METHOD: request.method ?? "GET",
				CONTENT_TYPE: request.headers["content-type"] ?? "",
				CONTENT_LENGTH: request.headers["content-length"] ?? "",
				...Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.startsWith("x-") || name === "git-protocol").map(([name, value]) => [`HTTP_${name.toUpperCase().replaceAll("-", "_")}`, value ?? ""])),
				REMOTE_ADDR: "127.0.0.1",
				SERVER_NAME: "127.0.0.1",
				SERVER_PORT: String(server.address()?.port ?? ""),
				SERVER_PROTOCOL: "HTTP/1.1",
				GATEWAY_INTERFACE: "CGI/1.1",
				SERVER_SOFTWARE: "thomo-smoke",
				SCRIPT_NAME: "",
				REQUEST_URI: request.url ?? "/",
				PATH_TRANSLATED: join(projectRoot, requestUrl.pathname),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		const output = [];
		let errorOutput = "";
		child.stdout.on("data", (chunk) => output.push(chunk));
		child.stderr.on("data", (chunk) => { errorOutput += chunk; });
		child.on("error", (error) => {
			response.writeHead(500, { "content-type": "text/plain" });
			response.end(String(error));
		});
		child.on("close", (code) => {
			if (response.writableEnded) return;
			const body = Buffer.concat(output);
			const separator = body.indexOf(Buffer.from("\r\n\r\n"));
			const separatorLength = separator >= 0 ? 4 : body.indexOf(Buffer.from("\n\n")) >= 0 ? 2 : 0;
			const headerEnd = separator >= 0 ? separator : body.indexOf(Buffer.from("\n\n"));
			if (headerEnd < 0) {
				console.error(`git http-backend request failed: ${request.method} ${request.url}; stderr=${errorOutput}; body=${body.toString("utf8")}`);
				response.writeHead(500, { "content-type": "text/plain" });
				response.end(errorOutput || body.toString("utf8") || `git http-backend exited with ${code}`);
				return;
			}
			const headers = {};
			let status = 200;
			for (const line of body.subarray(0, headerEnd).toString("utf8").split(/\r?\n/)) {
				const colon = line.indexOf(":");
				if (colon < 0) continue;
				const name = line.slice(0, colon).trim();
				const value = line.slice(colon + 1).trim();
				if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
				else headers[name] = value;
			}
			response.writeHead(status, headers);
			response.end(body.subarray(headerEnd + separatorLength));
		});
		request.pipe(child.stdin);
	});
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	assert.equal(typeof address, "object");
	return { server, port: address.port };
}

async function copyPackage(source, destination) {
	await cp(source, destination, {
		recursive: true,
		filter: (sourcePath) => {
			const rel = relative(source, sourcePath);
			return rel !== ".git" && !rel.startsWith(".git/") && rel !== "node_modules" && !rel.startsWith("node_modules/");
		},
	});
}

async function assertCleanPackageLoads(tempRoot) {
	const agentDir = join(tempRoot, "agent-clean");
	const projectDir = join(tempRoot, "project-clean");
	await mkdir(projectDir, { recursive: true });
	await run(PI_BIN, ["install", root], { cwd: projectDir, env: { ...piEnv, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });

	const probePath = join(tempRoot, "no-italic-probe.ts");
	await writeFile(probePath, `import { Theme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerCommand("thomo-no-italic-probe", { handler: (_args, ctx) => {
    ctx.ui.notify(Theme.prototype.italic("thomo-no-italic-probe-result"), "info");
  } });
  pi.registerCommand("thomo-tools-probe", { handler: (_args, ctx) => {
    const bashTools = pi.getAllTools().filter((tool) => tool.name === "bash").map((tool) => ({ name: tool.name, path: tool.sourceInfo.path }));
    ctx.ui.notify(JSON.stringify(bashTools), "info");
  } });
}
`);

	const rpc = await runRpc(agentDir, projectDir, [
		{ id: "commands", type: "get_commands" },
		{ id: "autotitle", type: "prompt", message: "/autotitle show" },
		{ id: "export", type: "prompt", message: "/export-md" },
		{ id: "probe", type: "prompt", message: "/thomo-no-italic-probe" },
		{ id: "tools", type: "prompt", message: "/thomo-tools-probe" },
	], ["-e", probePath]);
	assert.equal(rpc.code, 0, `Pi RPC failed:\n${rpc.stderr}\n${rpc.stdout}`);
	assert.equal(rpc.lines.some((line) => line.type === "extension_error"), false, `Extension error:\n${rpc.stdout}`);
	const commands = commandList(rpc);
	const packageCommands = commands.filter((command) => command.name === "autotitle" || command.name === "export-md");
	assert.deepEqual(packageCommands.map((command) => command.name).sort(), ["autotitle", "export-md"]);
	for (const command of packageCommands) {
		assert.match(command.sourceInfo.path.replaceAll("\\", "/"), new RegExp(`${packageRootPattern}/packages/thomo-[^/]+/index\\.ts$`));
		assert.equal(command.sourceInfo.origin, "package");
	}
	assert.equal(commands.filter((command) => command.name === "autotitle").length, 1);
	assert.equal(commands.filter((command) => command.name === "export-md").length, 1);
	assert.equal(commands.some((command) => command.sourceInfo?.path?.endsWith("format.ts")), false);
	assert.equal(response(rpc.lines, "autotitle")?.success, true);
	assert.equal(response(rpc.lines, "export")?.success, true);
	assert.equal(response(rpc.lines, "probe")?.success, true);
	assert.equal(response(rpc.lines, "tools")?.success, true);
	assert.equal(rpc.lines.some((line) => line.method === "notify" && line.message === "thomo-no-italic-probe-result"), true, "no-italic patch was not active");
	const bashToolProbe = rpc.lines.find((line) => line.method === "notify" && typeof line.message === "string" && line.message.startsWith("[{\"name\":\"bash\""));
	assert.ok(bashToolProbe, `bash-readable did not register a bash tool: ${JSON.stringify(rpc.lines)}`);
	const bashTools = JSON.parse(bashToolProbe.message);
	assert.equal(bashTools.length, 1);
	assert.match(bashTools[0].path.replaceAll("\\", "/"), new RegExp(`${packageRootPattern}/packages/thomo-bash-readable/index\\.ts$`));

	return { agentDir, projectDir };
}

async function assertLegacyCleanupScript(tempRoot) {
	const agentDir = join(tempRoot, "agent-cleanup");
	const extensionsDir = join(agentDir, "extensions");
	await mkdir(join(extensionsDir, "auto-title"), { recursive: true });
	await mkdir(join(extensionsDir, "bash-readable"), { recursive: true });
	await writeFile(join(extensionsDir, "auto-title", "index.ts"), "legacy auto-title");
	await writeFile(join(extensionsDir, "auto-title", "package.json"), "{}");
	await writeFile(join(extensionsDir, "bash-readable.ts"), "legacy bash-readable");
	await writeFile(join(extensionsDir, "bash-readable", "format.ts"), "legacy helper");
	await writeFile(join(extensionsDir, "export-md.ts"), "legacy export-md");
	await writeFile(join(extensionsDir, "no-italic.ts"), "legacy no-italic");
	await run(process.execPath, [join(root, "scripts", "disable-legacy-extensions.mjs")], {
		env: { ...piEnv, PI_CODING_AGENT_DIR: agentDir },
	});
	const remaining = await run(process.execPath, ["-e", `import { readdirSync } from "node:fs"; console.log(readdirSync(${JSON.stringify(extensionsDir)}).join("\\n"));`]);
	assert.equal(remaining.stdout.trim(), "");
	const backups = await run(process.execPath, ["-e", `import { readdirSync } from "node:fs"; console.log(readdirSync(${JSON.stringify(join(agentDir, "extensions-disabled", "thomo"))}).sort().join("\\n"));`]);
	assert.deepEqual(backups.stdout.trim().split("\n"), ["auto-title", "bash-readable-helper", "bash-readable.ts", "export-md.ts", "no-italic.ts"]);
}

async function assertAutoTitleBehavior(tempRoot) {
	const agentDir = join(tempRoot, "agent-auto-title");
	const projectDir = join(tempRoot, "project-auto-title");
	const providerPath = join(tempRoot, "auto-title-provider.ts");
	await mkdir(projectDir, { recursive: true });
	await run(PI_BIN, ["install", root], { cwd: projectDir, env: { ...piEnv, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });
	const fixture = startOpenAiFixtureServer();
	await new Promise((resolvePromise, reject) => {
		fixture.server.once("error", reject);
		fixture.server.listen(0, "127.0.0.1", resolvePromise);
	});
	const port = fixture.server.address().port;
	await writeFile(providerPath, `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 });
export default function (pi: ExtensionAPI) {
  const config = (provider: string, id: string) => pi.registerProvider(provider, {
    name: provider,
    baseUrl: "http://127.0.0.1:${port}/v1",
    apiKey: "fixture",
    api: "openai-completions",
    models: [model(id)]
  });
  config("fixture", "title");
  config("deepseek", "deepseek-v4-flash");
}
`);
	try {
		const rpc = await runRpcUntilSessionNamed(agentDir, projectDir, ["-e", providerPath], "Discuss a test fixture");
		assert.ok(rpc.code === 0 || rpc.code === 143, `auto-title RPC failed: ${rpc.stderr}; requests=${JSON.stringify(fixture.requests)}; lines=${JSON.stringify(rpc.lines)}`);
		const state = rpc.lines.find((line) => line.type === "response" && line.id === "state");
		assert.equal(state?.success, true, `auto-title state was not returned: ${JSON.stringify(rpc.lines)}`);
		const sessionHeader = JSON.parse((await readFile(state.data.sessionFile, "utf8")).split("\n", 1)[0]);
		const sessionDate = new Date(sessionHeader.timestamp);
		const pad = (value) => String(value).padStart(2, "0");
		const sessionTimestamp = `${String(sessionDate.getFullYear()).slice(-2)}${pad(sessionDate.getMonth() + 1)}${pad(sessionDate.getDate())}${pad(sessionDate.getHours())}${pad(sessionDate.getMinutes())}`;
		assert.equal(state.data.sessionName, `Fixture title (${sessionTimestamp})`);
		assert.deepEqual(fixture.requests.map((request) => request.model), ["title", "deepseek-v4-flash", "title"]);
		assert.equal(JSON.stringify(fixture.requests[1].messages).includes("<conversation>"), true);
	} finally {
		await new Promise((resolvePromise) => fixture.server.close(resolvePromise));
	}
}

async function assertStandaloneExtensionLoads(tempRoot) {
	const agentDir = join(tempRoot, "agent-standalone");
	const projectDir = join(tempRoot, "project-standalone");
	const extensionDir = join(root, "packages", "thomo-auto-title");
	await mkdir(projectDir, { recursive: true });
	await run(PI_BIN, ["install", extensionDir], {
		cwd: projectDir,
		env: { ...piEnv, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
	});
	const rpc = await runRpc(agentDir, projectDir, [{ id: "commands", type: "get_commands" }]);
	assert.equal(rpc.code, 0, `Standalone extension failed to load:\n${rpc.stderr}\n${rpc.stdout}`);
	assert.equal(rpc.lines.some((line) => line.type === "extension_error"), false, `Standalone extension error:\n${rpc.stdout}`);
	const commands = commandList(rpc);
	assert.equal(commands.filter((command) => command.name === "autotitle").length, 1);
	assert.equal(commands.some((command) => command.name === "export-md"), false);
	const autotitle = commands.find((command) => command.name === "autotitle");
	assert.equal(autotitle?.sourceInfo.origin, "package");
	assert.match(autotitle?.sourceInfo.path.replaceAll("\\", "/"), /packages\/thomo-auto-title\/index\.ts$/);
}

async function assertStandaloneBlockStyleLoads(tempRoot) {
	const agentDir = join(tempRoot, "agent-standalone-block-style");
	const projectDir = join(tempRoot, "project-standalone-block-style");
	const extensionDir = join(root, "packages", "thomo-block-style");
	const probePath = join(root, "packages", "thomo-block-style", "test-fixtures", "block-style-render-probe.ts");
	await mkdir(projectDir, { recursive: true });
	await run(PI_BIN, ["install", extensionDir], {
		cwd: projectDir,
		env: { ...piEnv, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
	});
	const rpc = await runRpc(agentDir, projectDir, [
		{ id: "commands", type: "get_commands" },
		{ id: "probe", type: "prompt", message: "/block-style-render-probe" },
		{ id: "halfHatch", type: "prompt", message: "/block-style half-hatch" },
		{ id: "outline", type: "prompt", message: "/block-style outline" },
		{ id: "rail", type: "prompt", message: "/block-style rail" },
		{ id: "spotlight", type: "prompt", message: "/block-style spotlight" },
		{ id: "invalid", type: "prompt", message: "/block-style hard" },
	], ["-e", probePath]);
	assert.equal(rpc.code, 0, `Standalone block-style failed to load:\n${rpc.stderr}\n${rpc.stdout}`);
	assert.equal(rpc.lines.some((line) => line.type === "extension_error"), false, `Standalone block-style error:\n${rpc.stdout}`);
	const commands = commandList(rpc);
	assert.equal(commands.filter((command) => command.name === "block-style").length, 1);
	assert.equal(commands.some((command) => command.name === "autotitle"), false);
	assert.equal(response(rpc.lines, "probe")?.success, true, `Standalone block-style probe failed:\n${rpc.stdout}`);
	assert.equal(response(rpc.lines, "halfHatch")?.success, true, `Standalone block-style half-hatch mode failed:\n${rpc.stdout}`);
	assert.equal(response(rpc.lines, "outline")?.success, true, `Standalone block-style outline mode failed:\n${rpc.stdout}`);
	assert.equal(response(rpc.lines, "rail")?.success, true, `Standalone block-style rail mode failed:\n${rpc.stdout}`);
	assert.equal(response(rpc.lines, "spotlight")?.success, true, `Standalone block-style spotlight mode failed:\n${rpc.stdout}`);
	assert.equal(response(rpc.lines, "invalid")?.success, true, `Standalone block-style invalid mode failed:\n${rpc.stdout}`);
	assert.equal(rpc.lines.some((line) => line.method === "notify" && line.message === "Block style: half-hatch"), true);
	assert.equal(rpc.lines.some((line) => line.method === "notify" && line.message === "Block style: outline"), true);
	assert.equal(rpc.lines.some((line) => line.method === "notify" && line.message === "Block style: rail"), true);
	assert.equal(rpc.lines.some((line) => line.method === "notify" && line.message === "Block style: spotlight"), true);
	assert.equal(rpc.lines.some((line) => line.method === "notify" && line.message === "Usage: /block-style [half|half-hatch|full|deep|outline|rail|spotlight|off]"), true);
	const blockStyle = commands.find((command) => command.name === "block-style");
	assert.equal(blockStyle?.sourceInfo.origin, "package");
	assert.match(blockStyle?.sourceInfo.path.replaceAll("\\", "/"), /packages\/thomo-block-style\/index\.ts$/);
}

async function assertLegacyCopiesAreRejected(tempRoot) {
	const agentDir = join(tempRoot, "agent-legacy");
	const projectDir = join(tempRoot, "project-legacy");
	const legacyDir = join(agentDir, "extensions", "auto-title");
	await mkdir(projectDir, { recursive: true });
	await mkdir(legacyDir, { recursive: true });
	await cp(join(root, "packages", "thomo-auto-title", "index.ts"), join(legacyDir, "index.ts"));
	await writeFile(join(legacyDir, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
	await run(PI_BIN, ["install", root], { cwd: projectDir, env: { ...piEnv, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });
	const rpc = await runRpc(agentDir, projectDir, [{ id: "commands", type: "get_commands" }]);
	assert.equal(rpc.code, 0, `Pi should report duplicate commands without crashing:\n${rpc.stderr}`);
	const commands = commandList(rpc);
	assert.equal(commands.some((command) => command.name === "autotitle:1"), true);
	assert.equal(commands.some((command) => command.name === "autotitle:2"), true);
	assert.equal(commands.filter((command) => command.name.startsWith("autotitle:")).length, 2);
	assert.equal(commands.some((command) => command.sourceInfo?.source === "auto"), true);

	const exportAgentDir = join(tempRoot, "agent-legacy-export");
	const exportProjectDir = join(tempRoot, "project-legacy-export");
	await mkdir(join(exportAgentDir, "extensions"), { recursive: true });
	await mkdir(exportProjectDir, { recursive: true });
	await cp(join(root, "packages", "thomo-export-md", "index.ts"), join(exportAgentDir, "extensions", "export-md.ts"));
	await run(PI_BIN, ["install", root], { cwd: exportProjectDir, env: { ...piEnv, PI_CODING_AGENT_DIR: exportAgentDir, PI_OFFLINE: "1" } });
	const exportRpc = await runRpc(exportAgentDir, exportProjectDir, [{ id: "commands", type: "get_commands" }]);
	assert.equal(exportRpc.code, 0, `Pi should report duplicate export commands without crashing:\n${exportRpc.stderr}`);
	const exportCommands = commandList(exportRpc);
	assert.deepEqual(exportCommands.filter((command) => command.name.startsWith("export-md:")).map((command) => command.name).sort(), ["export-md:1", "export-md:2"]);

	const bashAgentDir = join(tempRoot, "agent-legacy-bash");
	const bashProjectDir = join(tempRoot, "project-legacy-bash");
	await mkdir(join(bashAgentDir, "extensions", "bash-readable"), { recursive: true });
	await mkdir(bashProjectDir, { recursive: true });
	const legacyBash = await readFile(join(root, "packages", "thomo-bash-readable", "index.ts"), "utf8");
	await writeFile(join(bashAgentDir, "extensions", "bash-readable.ts"), legacyBash.replace("./format.ts", "./bash-readable/format.ts"));
	await cp(join(root, "packages", "thomo-bash-readable", "format.ts"), join(bashAgentDir, "extensions", "bash-readable", "format.ts"));
	await run(PI_BIN, ["install", root], { cwd: bashProjectDir, env: { ...piEnv, PI_CODING_AGENT_DIR: bashAgentDir, PI_OFFLINE: "1" } });
	const bashRpc = await runRpc(bashAgentDir, bashProjectDir, [{ id: "commands", type: "get_commands" }]);
	assert.notEqual(bashRpc.code, 0);
	assert.match(bashRpc.stderr, /Tool \"bash\" conflicts with/);
}

async function assertGitUpdates(tempRoot) {
	const sourceWork = join(tempRoot, "git-source");
	const bareRoot = join(tempRoot, "git-remote");
	const bareRepo = join(bareRoot, "thomo", "thomo.git");
	const agentDir = join(tempRoot, "agent-git");
	const projectDir = join(tempRoot, "project-git");
	await mkdir(join(bareRoot, "thomo"), { recursive: true });
	await mkdir(projectDir, { recursive: true });
	await copyPackage(root, sourceWork);
	await run("git", ["init", "-b", "main"], { cwd: sourceWork });
	await run("git", ["config", "user.email", "thomo-smoke@example.invalid"], { cwd: sourceWork });
	await run("git", ["config", "user.name", "thomo smoke test"], { cwd: sourceWork });
	await run("git", ["add", "."], { cwd: sourceWork });
	await run("git", ["commit", "-m", "test: initial package"], { cwd: sourceWork });
	await run("git", ["init", "--bare", "--initial-branch=main", bareRepo], { cwd: bareRoot });
	await run("git", ["remote", "add", "origin", bareRepo], { cwd: sourceWork });
	await run("git", ["push", "--set-upstream", "origin", "main"], { cwd: sourceWork });
	await run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: bareRepo });

	const gitServer = await startGitHttpServer(bareRoot);
	try {
		const sourceUrl = `http://127.0.0.1:${gitServer.port}/thomo/thomo.git`;
		await run(PI_BIN, ["install", sourceUrl], { cwd: projectDir, env: { ...piEnv, PI_CODING_AGENT_DIR: agentDir } });
		const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
		assert.deepEqual(settings.packages, [sourceUrl], "the update source must remain unpinned");

		const marker = "thomo update marker";
		const exportPath = join(sourceWork, "packages", "thomo-export-md", "index.ts");
		const exportSource = await readFile(exportPath, "utf8");
		await writeFile(exportPath, exportSource.replace(
			"Nothing to export - no prompts or replies in this session yet",
			`Nothing to export - no prompts or replies in this session yet (${marker})`,
		));
		await run("git", ["add", "."], { cwd: sourceWork });
		await run("git", ["commit", "-m", "test: advance package"], { cwd: sourceWork });
		const newHead = (await run("git", ["rev-parse", "HEAD"], { cwd: sourceWork })).stdout.trim();
		await run("git", ["push", "origin", "main"], { cwd: sourceWork });
		await run(PI_BIN, ["update", "--extensions"], { cwd: projectDir, env: { ...piEnv, PI_CODING_AGENT_DIR: agentDir } });

		const managedRoot = join(agentDir, "git", "127.0.0.1", "thomo", "thomo");
		assert.equal((await run("git", ["rev-parse", "HEAD"], { cwd: managedRoot })).stdout.trim(), newHead);
		const updatedRpc = await runRpc(agentDir, projectDir, [
			{ id: "commands", type: "get_commands" },
			{ id: "export", type: "prompt", message: "/export-md" },
		]);
		assert.equal(updatedRpc.code, 0, `Pi failed after Git update:\n${updatedRpc.stderr}`);
		assert.equal(response(updatedRpc.lines, "export")?.success, true);
		assert.equal(updatedRpc.lines.some((line) => line.type === "extension_ui_request" && line.message.includes(marker)), true);
	} finally {
		await new Promise((resolvePromise) => gitServer.server.close(resolvePromise));
	}
}

const tempRoot = await mkdtemp(join(tmpdir(), "thomo-smoke-"));
try {
	await assertCleanPackageLoads(tempRoot);
	await assertStandaloneExtensionLoads(tempRoot);
	await assertStandaloneBlockStyleLoads(tempRoot);
	await assertLegacyCopiesAreRejected(tempRoot);
	await assertLegacyCleanupScript(tempRoot);
	await assertAutoTitleBehavior(tempRoot);
	await assertGitUpdates(tempRoot);
	console.log("thomo package smoke tests passed: clean discovery, duplicate detection, and unpinned Git update.");
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}
