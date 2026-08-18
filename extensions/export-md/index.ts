/**
 * /export-md - export the current pi session to a clean, filtered Markdown file.
 *
 * Unlike the built-in /export (HTML / JSONL), this renders only what a human
 * wants to read: user prompts and assistant text replies. Tool calls, tool
 * outputs, bash executions, thinking blocks, compaction summaries, model
 * switches, and all other session machinery are omitted.
 *
 * Usage:
 *   /export-md               -> session-<timestamp>.md in cwd
 *   /export-md out.md        -> out.md (relative to cwd, or absolute path)
 *   /export-md "my notes.md" -> quoted paths with spaces
 *
 * The built-in /export cannot be shadowed by an extension (built-in commands
 * are intercepted in the editor submit handler before extension commands are
 * consulted), so this is a sibling command.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

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

type SessionEntry = {
	type: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		model?: string;
	};
};


function formatDate(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface RenderOptions {
	sessionName?: string;
	cwd?: string;
}

/**
 * Render the branch entries as filtered Markdown: "## You" / "## Assistant"
 * sections with their text only. Tool-only assistant turns are skipped.
 */
export function renderMarkdown(entries: SessionEntry[], opts: RenderOptions = {}): string {
	const lines: string[] = [];
	const meta: string[] = [];
	if (opts.sessionName?.trim()) {
		meta.push(`session: ${opts.sessionName.trim()}`);
	}
	if (opts.cwd) {
		meta.push(`cwd: \`${opts.cwd}\``);
	}
	meta.push(`exported: ${formatDate(new Date())}`);
	lines.push(`_${meta.join(" - ")}_`);
	lines.push("");
	lines.push("Only prompts and assistant replies are included; tool calls, outputs, and thinking blocks are omitted.");
	lines.push("");

	let count = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) {
			continue;
		}
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") {
			continue;
		}
		const text = extractText(entry.message.content).trim();
		if (!text) {
			continue; // tool-only turn with no visible reply
		}
		// Message headers are level-1 so any headings inside an assistant's
		// reply (level 2 and below) stay visually nested under it.
		if (role === "user") {
			lines.push("# You");
		} else {
			const model = entry.message.model ? ` (${entry.message.model})` : "";
			lines.push(`# Assistant${model}`);
		}
		if (entry.timestamp) {
			lines.push(`_${formatDate(new Date(entry.timestamp))}_`);
		}
		lines.push("");
		lines.push(text);
		lines.push("");
		count++;
	}

	if (count === 0) {
		return "";
	}
	return lines.join("\n").trimEnd() + "\n";
}

/** Parse a /command path argument: quoted or up to first whitespace. */
export function parsePathArg(args: string): string | undefined {
	const trimmed = args.trimStart();
	if (!trimmed) {
		return undefined;
	}
	const first = trimmed[0];
	if (first === '"' || first === "'") {
		const end = trimmed.indexOf(first, 1);
		return end < 0 ? undefined : trimmed.slice(1, end);
	}
	const ws = trimmed.search(/\s/);
	return ws < 0 ? trimmed : trimmed.slice(0, ws);
}

function defaultName(): string {
	return `session-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("export-md", {
		description: "Export session to filtered Markdown (prompts + replies only)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const outPath = resolve(ctx.cwd, parsePathArg(args) ?? defaultName());
			const entries = ctx.sessionManager.getBranch() as unknown as SessionEntry[];
			const md = renderMarkdown(entries, {
				sessionName: ctx.sessionManager.getSessionName(),
				cwd: ctx.cwd,
			});
			if (!md) {
				ctx.ui.notify("Nothing to export - no prompts or replies in this session yet", "warning");
				return;
			}
			try {
				mkdirSync(dirname(outPath), { recursive: true });
				writeFileSync(outPath, md, "utf8");
				ctx.ui.notify(`Exported to: ${outPath}`, "info");
			} catch (err) {
				ctx.ui.notify(`Export failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
