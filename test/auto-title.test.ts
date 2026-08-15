import test from "node:test";
import assert from "node:assert/strict";
import {
	buildConversationSample,
	cleanTitle,
	CONVERSATION_SAMPLE_MAX_CHARS,
	DEFAULT_TITLE_MODELS,
	extractText,
	formatSessionTimestamp,
	TITLE_TIMEOUT_MS,
	withTimeout,
} from "../extensions/auto-title/helpers.ts";

test("normalizes generated titles to sentence case and a bounded length", () => {
	assert.equal(cleanTitle("```\n  \"FIX THE LOGIN BUG!!!\"\n```\nignored"), "Fix the login bug");
	assert.equal(cleanTitle("  multiple   words\nsecond line"), "Multiple words");
	assert.equal(cleanTitle("   ... !!!   "), undefined);
	assert.equal(cleanTitle("A".repeat(80))?.length, 40);
});

test("preserves proper nouns when the model already uses sentence case", () => {
	assert.equal(cleanTitle("Using ChatGPT for a quick fix"), "Using ChatGPT for a quick fix");
	assert.equal(cleanTitle("Set up TypeScript in VS Code"), "Set up TypeScript in VS Code");
	assert.equal(cleanTitle("CHATGPT VS CLAUDE"), "Chatgpt vs claude");
});

test("keeps the first and latest user goals while bounding conversation context", () => {
	const sample = buildConversationSample([
		{ role: "user", text: "First goal" },
		{ role: "assistant", text: "First answer" },
		{ role: "user", text: "An intermediate request that should not dominate the title" },
		{ role: "assistant", text: "A long intermediate answer that should be omitted" },
		{ role: "user", text: "Latest goal" },
		{ role: "assistant", text: "Latest answer" },
	]);

	assert.equal(
		sample,
		"User: First goal\n\nAssistant: First answer\n\n[...messages omitted...]\n\nUser: Latest goal\n\nAssistant: Latest answer",
	);
	assert.equal(sample.includes("intermediate"), false);
});

test("clips long messages at paragraph boundaries within the sample budget", () => {
	const sample = buildConversationSample([
		{ role: "user", text: `first start\n\n${"x".repeat(5000)}\n\nfirst end` },
		{ role: "assistant", text: "first answer" },
		{ role: "user", text: `latest start\n\n${"y".repeat(5000)}\n\nlatest end` },
		{ role: "assistant", text: "latest answer" },
	]);

	assert.ok(sample.length <= CONVERSATION_SAMPLE_MAX_CHARS);
	assert.match(sample, /first start/);
	assert.match(sample, /first end/);
	assert.match(sample, /latest start/);
	assert.match(sample, /latest end/);
	assert.doesNotMatch(sample, /x{100}/);
	assert.doesNotMatch(sample, /y{100}/);
});

test("formats persisted session timestamps and rejects invalid dates", () => {
	assert.equal(formatSessionTimestamp("2026-08-12T14:18:03.941Z"), "2608121418");
	assert.equal(formatSessionTimestamp("not a timestamp"), undefined);
});

test("keeps auto-title model order, timeout, and visible text extraction stable", async () => {
	assert.deepEqual(DEFAULT_TITLE_MODELS, ["deepseek/deepseek-v4-flash", "openai-codex/gpt-5.6-luna"]);
	assert.equal(TITLE_TIMEOUT_MS, 30_000);
	assert.equal(extractText([{ type: "text", text: "user" }, { type: "thinking", text: "hidden" }]), "user");

	let timedOut = false;
	await assert.rejects(
		withTimeout(new Promise<never>(() => {}), 5, "fixture timeout", () => { timedOut = true; }),
		/fixture timeout/,
	);
	assert.equal(timedOut, true);
});
