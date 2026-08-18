import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { formatShellCommand, splitShellCommand } from "./format.ts";

test("splits top-level chaining operators but keeps pipelines inline", () => {
	assert.deepEqual(splitShellCommand("cd /workspace && npm test; echo done"), [
		{ text: "cd /workspace ", connector: "&&" },
		{ text: " npm test", connector: ";" },
		{ text: " echo done" },
	]);
	assert.deepEqual(formatShellCommand("cd /workspace && npm test | tee out.txt || echo failed"), [
		"$ cd /workspace &&",
		"> npm test | tee out.txt || echo failed",
	]);
});

test("does not split operators inside shell syntax", () => {
	assert.deepEqual(formatShellCommand("printf '%s; %s' 'a && b' && if [[ $x == 'a;b' ]]; then echo ok; fi"), [
		"$ printf '%s; %s' 'a && b' &&",
		"> if [[ $x == 'a;b' ]]; then echo ok; fi",
	]);
	assert.deepEqual(formatShellCommand("cat file 2>&1 &>output && echo ready"), [
		"$ cat file 2>&1 &>output &&",
		"> echo ready",
	]);
});

test("preserves multiline command lines and continuation prompts", () => {
	assert.deepEqual(formatShellCommand("echo one\necho two && echo three"), [
		"$ echo one",
		"> echo two &&",
		"> echo three",
	]);
});

test("resolves bash execution from the active session cwd", async () => {
	const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /createBashTool\(process\.cwd\(\)\)/);
	assert.match(source, /const bash = createBashTool\(ctx\.cwd\)/);
});
