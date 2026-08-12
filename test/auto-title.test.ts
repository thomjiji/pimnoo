import test from "node:test";
import assert from "node:assert/strict";
import {
	cleanTitle,
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
	assert.equal(cleanTitle("A".repeat(80))?.length, 60);
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
