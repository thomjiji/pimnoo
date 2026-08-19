import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import piRemotePrototype from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("declares a standalone Pi package", () => {
	const manifest = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
	assert.equal(manifest.name, "pimono-pi-remote");
	assert.equal(manifest.private, true);
	assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
});

test("stays disabled by default and can serve an authenticated snapshot on demand", async () => {
	const previous = {
		enabled: process.env.PI_REMOTE_ENABLED,
		host: process.env.PI_REMOTE_HOST,
		port: process.env.PI_REMOTE_PORT,
		token: process.env.PI_REMOTE_TOKEN,
		public_url: process.env.PI_REMOTE_PUBLIC_URL,
	};
	delete process.env.PI_REMOTE_ENABLED;
	delete process.env.PI_REMOTE_PUBLIC_URL;
	process.env.PI_REMOTE_HOST = "127.0.0.1";
	process.env.PI_REMOTE_PORT = "0";
	process.env.PI_REMOTE_TOKEN = "test-token";

	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => any) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, command);
		},
		getSessionName() {
			return "Prototype test";
		},
	};
	const ctx = {
		cwd: "/tmp/prototype-test",
		sessionManager: {
			getSessionId: () => "session-test",
			getSessionFile: () => undefined,
			getBranch: () => [],
		},
		ui: {
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			notify: (message: string) => notifications.push(message),
		},
	};

	try {
		piRemotePrototype(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		assert.deepEqual(statuses, []);
		assert.deepEqual([...commands.keys()].sort(), ["pi-remote-start", "pi-remote-stop", "pi-remote-url"]);

		await commands.get("pi-remote-start")!.handler("--port 0", ctx);
		const announced = notifications.at(-1);
		assert.match(announced!, /token=test-token$/);
		const url = new URL(announced!.replace("Pi Remote Prototype: ", ""));

		const health = await fetch(new URL("/health", url));
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), { ok: true, prototype: true });

		const unauthorized = await fetch(new URL("/api/snapshot", url.origin));
		assert.equal(unauthorized.status, 401);

		const snapshot = await fetch(new URL(`/api/snapshot?token=${url.searchParams.get("token")}`, url.origin));
		assert.equal(snapshot.status, 200);
		const body = await snapshot.json();
		assert.equal(body.session.id, "session-test");
		assert.equal(body.status, "idle");
	} finally {
		await commands.get("pi-remote-stop")?.handler("", ctx);
		for (const [key, value] of Object.entries(previous)) {
			const envName = `PI_REMOTE_${key.toUpperCase()}`;
			if (value === undefined) delete process.env[envName];
			else process.env[envName] = value;
		}
	}
});

test("keeps its generated token stable across session extension instances", async () => {
	const previous = {
		enabled: process.env.PI_REMOTE_ENABLED,
		host: process.env.PI_REMOTE_HOST,
		port: process.env.PI_REMOTE_PORT,
		token: process.env.PI_REMOTE_TOKEN,
		public_url: process.env.PI_REMOTE_PUBLIC_URL,
	};
	delete process.env.PI_REMOTE_ENABLED;
	delete process.env.PI_REMOTE_TOKEN;
	delete process.env.PI_REMOTE_PUBLIC_URL;
	process.env.PI_REMOTE_HOST = "127.0.0.1";
	process.env.PI_REMOTE_PORT = "0";

	const startOneInstance = async (sessionId: string) => {
		const handlers = new Map<string, (event: any, ctx: any) => any>();
		const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		const notifications: string[] = [];
		const pi = {
			on: (name: string, handler: (event: any, ctx: any) => any) => handlers.set(name, handler),
			registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, command),
			getSessionName: () => sessionId,
		};
		const ctx = {
			cwd: "/tmp/prototype-test",
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionFile: () => undefined,
				getBranch: () => [],
			},
			ui: {
				setStatus: () => {},
				notify: (message: string) => notifications.push(message),
			},
		};
		piRemotePrototype(pi as any);
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("pi-remote-start")!.handler("--host 127.0.0.1 --port 0", ctx);
		const announced = notifications.at(-1)!.replace("Pi Remote Prototype: ", "");
		await commands.get("pi-remote-stop")!.handler("", ctx);
		return new URL(announced).searchParams.get("token");
	};

	try {
		const firstToken = await startOneInstance("session-one");
		const resumedToken = await startOneInstance("session-two");
		assert.equal(resumedToken, firstToken);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			const envName = `PI_REMOTE_${key.toUpperCase()}`;
			if (value === undefined) delete process.env[envName];
			else process.env[envName] = value;
		}
	}
});
