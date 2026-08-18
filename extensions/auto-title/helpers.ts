export const CONVERSATION_SAMPLE_MAX_CHARS = 4000;
export const MAX_TITLE_CHARS = 40;
export const USER_MESSAGE_SAMPLE_CHARS = 1400;
export const ASSISTANT_MESSAGE_SAMPLE_CHARS = 500;
export const TITLE_TIMEOUT_MS = 30_000;
export const DEFAULT_TITLE_MODELS = ["deepseek/deepseek-v4-flash", "openai-codex/gpt-5.6-luna"] as const;

export const withTimeout = <T>(
	promise: Promise<T>,
	timeoutMs: number,
	timeoutMessage: string,
	onTimeout: () => void,
): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			onTimeout();
			reject(new Error(timeoutMessage));
		}, timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
};

export const formatSessionTimestamp = (timestamp: string): string | undefined => {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return undefined;
	}
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${String(date.getFullYear()).slice(-2)}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
};

export const extractText = (content: unknown): string => {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}

		const part = block as { type?: unknown; text?: unknown };
		if (part.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		}
	}

	return parts.join("\n");
};

export type ConversationMessage = {
	role: "user" | "assistant";
	text: string;
};

const clipFragment = (text: string, maxChars: number): string => {
	const omitted = " [...] ";
	const available = Math.max(0, maxChars - omitted.length);
	const front = Math.ceil(available / 2);
	const back = Math.floor(available / 2);
	return `${text.slice(0, front).trimEnd()}${omitted}${text.slice(text.length - back).trimStart()}`;
};

const clipMessage = (text: string, maxChars: number): string => {
	if (text.length <= maxChars) {
		return text;
	}

	const paragraphs = text
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0);
	if (paragraphs.length < 2) {
		return clipFragment(text, maxChars);
	}

	const omitted = "\n\n[...paragraphs omitted...]\n\n";
	const available = Math.max(0, maxChars - omitted.length);
	const firstBudget = Math.ceil(available / 2);
	const lastBudget = Math.floor(available / 2);
	const first = paragraphs[0].length <= firstBudget ? paragraphs[0] : clipFragment(paragraphs[0], firstBudget);
	const last = paragraphs.at(-1)!;
	const clippedLast = last.length <= lastBudget ? last : clipFragment(last, lastBudget);
	return `${first}${omitted}${clippedLast}`;
};

/**
 * Selects the conversation context most useful for naming a session.
 *
 * The first and latest user messages carry the strongest signal about the
 * session's topic and current goal. Assistant messages provide context only
 * after those anchors have been selected. Selected messages remain in their
 * original order, with explicit markers for omitted messages.
 */
export const buildConversationSample = (messages: readonly ConversationMessage[]): string => {
	const visible = messages
		.map((message) => ({ ...message, text: message.text.trim() }))
		.filter((message) => message.text.length > 0);
	if (!visible.some((message) => message.role === "user")) {
		return "";
	}

	const firstUser = visible.findIndex((message) => message.role === "user");
	const latestUser = visible.findLastIndex((message) => message.role === "user");
	const firstAssistant = visible.findIndex((message) => message.role === "assistant");
	const latestAssistant = visible.findLastIndex((message) => message.role === "assistant");
	const selectedIndexes = new Set(
		[firstUser, latestUser, latestAssistant, firstAssistant].filter((index) => index >= 0),
	);
	const selected = [...selectedIndexes].sort((a, b) => a - b);

	const parts: string[] = [];
	let previousIndex = -1;
	for (const index of selected) {
		if (previousIndex >= 0 && index > previousIndex + 1) {
			parts.push("[...messages omitted...]");
		}

		const message = visible[index];
		const maxChars = message.role === "user" ? USER_MESSAGE_SAMPLE_CHARS : ASSISTANT_MESSAGE_SAMPLE_CHARS;
		parts.push(`${message.role === "user" ? "User" : "Assistant"}: ${clipMessage(message.text, maxChars)}`);
		previousIndex = index;
	}

	return parts.join("\n\n");
};

export const cleanTitle = (raw: string): string | undefined => {
	let t = raw.trim();

	// Strip markdown code fences and bold markers.
	t = t.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```\s*$/, "");
	t = t.replace(/\*\*|__/g, "");

	// Take the first non-empty line.
	const line = t
		.split("\n")
		.map((s) => s.trim())
		.find((s) => s.length > 0);
	if (!line) {
		return undefined;
	}
	t = line;

	// Strip surrounding quotes (ASCII and CJK).
	t = t.replace(/^[\s"'`\u201c\u201d\u2018\u2019]+/, "").replace(/[\s"'`\u201c\u201d\u2018\u2019]+$/, "");

	// Strip trailing punctuation.
	t = t.replace(/[.\u3002!\uFF01?\uFF1F:\uFF1A;\uFF1B,\uFF0C\s]+$/, "");

	// Collapse internal whitespace and enforce sentence case: capitalize the
	// first character. Preserve the model's casing so proper nouns like
	// "ChatGPT" survive; only normalize to lowercase when the model shouted
	// (all caps, no lowercase letters at all).
	t = t.replace(/\s+/g, " ").trim();
	if (/[A-Z]/.test(t) && !/[a-z]/.test(t)) {
		t = t.toLowerCase();
	}
	if (t.length > 0) {
		t = t.charAt(0).toUpperCase() + t.slice(1);
	}

	if (t.length === 0) {
		return undefined;
	}
	if (t.length > MAX_TITLE_CHARS) {
		t = t.slice(0, MAX_TITLE_CHARS).trimEnd();
	}
	return t;
};
