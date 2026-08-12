import test from "node:test";
import assert from "node:assert/strict";
import { extractText, parsePathArg, renderMarkdown } from "../extensions/export-md/index.ts";

test("extracts visible text from string and content blocks", () => {
	assert.equal(extractText("plain text"), "plain text");
	assert.equal(
		extractText([
			{ type: "thinking", thinking: "hidden" },
			{ type: "text", text: "first" },
			null,
			{ type: "text", text: "second" },
		]),
		"first\nsecond",
	);
	assert.equal(extractText({ type: "text", text: "not an array" }), "");
});

test("renders only user prompts and visible assistant replies", () => {
	const markdown = renderMarkdown(
		[
			{ type: "custom", timestamp: "2026-01-01T00:00:00.000Z" },
			{
				type: "message",
				timestamp: "2026-01-01T00:01:00.000Z",
				message: { role: "user", content: "Please explain this" },
			},
			{
				type: "message",
				timestamp: "2026-01-01T00:02:00.000Z",
				message: { role: "assistant", model: "test-model", content: [{ type: "text", text: "Here is the explanation." }] },
			},
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", text: "not visible" }] },
			},
		],
		{ sessionName: "Readable export", cwd: "/tmp/project" },
	);

	assert.match(markdown, /^_session: Readable export - cwd: `\/tmp\/project` - exported: .*_/);
	assert.match(markdown, /# You\n_2026-01-01 00:01_/);
	assert.match(markdown, /Please explain this/);
	assert.match(markdown, /# Assistant \(test-model\)\n_2026-01-01 00:02_/);
	assert.match(markdown, /Here is the explanation\./);
	assert.doesNotMatch(markdown, /not visible/);
});

test("returns an empty document when no visible messages exist", () => {
	assert.equal(renderMarkdown([{ type: "message", message: { role: "assistant", content: [] } }]), "");
});

test("parses quoted, unquoted, and missing path arguments", () => {
	assert.equal(parsePathArg("  notes.md extra"), "notes.md");
	assert.equal(parsePathArg('"notes with spaces.md"'), "notes with spaces.md");
	assert.equal(parsePathArg("'single quoted.md'"), "single quoted.md");
	assert.equal(parsePathArg("   "), undefined);
	assert.equal(parsePathArg('"unterminated'), undefined);
});
