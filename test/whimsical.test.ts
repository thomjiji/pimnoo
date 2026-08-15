import test from "node:test";
import assert from "node:assert/strict";
import whimsical, { messages, pickRandom } from "../extensions/whimsical/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("keeps the complete upstream message set (246 short + 207 long)", () => {
	assert.equal(messages.length, 453);
});

test("keeps the original English messages with the ASCII ellipsis", () => {
	assert.equal(messages[0], "Schlepping...");
	assert.equal(messages.at(-1), "Cherry-picking the commits...");
	for (const message of messages) {
		assert.match(message, /[A-Za-z]/);
		assert.match(message, /\.\.\.$/);
	}
});

test("never repeats a message in the pool", () => {
	assert.equal(new Set(messages).size, messages.length);
});

test("pickRandom always returns a message from the pool", () => {
	for (let i = 0; i < 200; i++) {
		assert.ok(messages.includes(pickRandom()));
	}
});

test("sets a random whimsical message on turn start and resets on turn end", async () => {
	const handlers = new Map<string, (event: unknown, ctx: { ui: { setWorkingMessage(message?: string): void } }) => void | Promise<void>>();
	const calls: Array<string | undefined> = [];
	const ctx = {
		ui: {
			setWorkingMessage(message?: string) {
				calls.push(message);
			},
		},
	};
	const pi = {
		on(event: string, handler: (event: unknown, ctx: typeof ctx) => void | Promise<void>) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;

	whimsical(pi);
	assert.ok(handlers.has("turn_start"));
	assert.ok(handlers.has("turn_end"));

	await handlers.get("turn_start")!({}, ctx);
	assert.equal(calls.length, 1);
	assert.ok(messages.includes(calls[0]!), "turn_start should set a working message from the pool");

	await handlers.get("turn_end")!({}, ctx);
	assert.equal(calls.length, 2);
	assert.equal(calls[1], undefined, "turn_end should reset the working message to the default");
});
