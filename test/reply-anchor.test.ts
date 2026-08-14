import test from "node:test";
import assert from "node:assert/strict";
import { REPLY_ANCHOR, addReplyAnchor } from "../extensions/reply-anchor/index.ts";

test("prefixes visible assistant replies with the searchable anchor", () => {
	assert.equal(addReplyAnchor("Here is the answer.", "assistant"), `${REPLY_ANCHOR}\n\nHere is the answer.`);
});

test("keeps Markdown blocks after the anchor", () => {
	assert.equal(addReplyAnchor("# Heading\n\nDetails", "assistant"), `${REPLY_ANCHOR}\n\n# Heading\n\nDetails`);
});

test("leaves user text and empty assistant updates unchanged", () => {
	assert.equal(addReplyAnchor("User prompt", "user"), "User prompt");
	assert.equal(addReplyAnchor("   ", "assistant"), "   ");
	assert.equal(addReplyAnchor("", "assistant"), "");
});

test("does not add the anchor twice when the transformer is applied again", () => {
	const anchored = `${REPLY_ANCHOR}\n\nAlready anchored`;
	assert.equal(addReplyAnchor(anchored, "assistant"), anchored);
});
