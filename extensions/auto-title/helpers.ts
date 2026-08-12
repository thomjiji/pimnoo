export const FRONT_SAMPLE_CHARS = 4500;
export const BACK_SAMPLE_CHARS = 1500;
export const MAX_TITLE_CHARS = 60;
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

export { extractText } from "../shared/text.ts";

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

	// Collapse internal whitespace and enforce sentence case: capitalize only
	// the first character, with all following characters in lowercase.
	t = t.replace(/\s+/g, " ").trim();
	t = t.toLowerCase();
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
