import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A rare, visible character that can be searched in terminal scrollback. */
export const REPLY_ANCHOR = "§";

type MarkdownMessageType = "user" | "assistant" | "assistant-thinking";

/**
 * Add a terminal-searchable line before visible assistant Markdown.
 *
 * This is intentionally a display-only transformation: the original message
 * remains unchanged in the session and in the model context.
 */
export function addReplyAnchor(markdown: string, messageType: MarkdownMessageType): string {
	if (messageType !== "assistant" || !markdown.trim()) {
		return markdown;
	}

	const prefix = `${REPLY_ANCHOR}\n\n`;
	return markdown.startsWith(prefix) ? markdown : prefix + markdown;
}

export default function replyAnchor(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer((markdown, { messageType }) => addReplyAnchor(markdown, messageType));
}
