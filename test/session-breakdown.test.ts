import test from "node:test";
import assert from "node:assert/strict";

import { FULLSCREEN_VIEW_OPTIONS, frameWithPiBorders } from "../extensions/session-breakdown/layout.ts";

test("frames the session dashboard with Pi's open top and bottom borders", () => {
	const border = "─".repeat(12);
	assert.deepEqual(frameWithPiBorders(["header", "body"], 6, border), [
		border,
		"",
		"header",
		"body",
		"",
		border,
	]);
});

test("keeps both borders when a dashboard is taller than the terminal", () => {
	const border = "─".repeat(8);
	const lines = frameWithPiBorders(["one", "two", "three", "four"], 5, border);
	assert.equal(lines.length, 5);
	assert.equal(lines[0], border);
	assert.equal(lines.at(-1), border);
});

test("opens both loading and dashboard views as full-screen overlays", () => {
	assert.deepEqual(FULLSCREEN_VIEW_OPTIONS, {
		overlay: true,
		overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
	});
});
