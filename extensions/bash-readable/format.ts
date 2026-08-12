export interface ShellCommandPart {
	text: string;
	connector?: string;
}

const COMPOUND_KEYWORDS = new Set(["then", "do", "else", "elif", "fi", "done", "esac", "in"]);
const LINE_BREAK_CONNECTORS = new Set(["&&", ";", "&"]);

function nextWord(command: string, start: number): string {
	let index = start;
	while (/\s/.test(command[index] ?? "")) index++;
	const match = command.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
	return match?.[0] ?? "";
}

function isSafeSemicolon(command: string, index: number): boolean {
	if (command[index - 1] === ";" || command[index + 1] === ";" || command[index + 1] === "&") return false;
	return !COMPOUND_KEYWORDS.has(nextWord(command, index + 1));
}

function isStandaloneAmpersand(command: string, index: number): boolean {
	const previous = command[index - 1];
	const next = command[index + 1];

	// Protect Bash redirections such as &>, &>>, >&file, 2>&1, and &<file.
	// Also protect case terminators such as ;& and ;;&.
	return (
		previous !== ">" &&
		previous !== "<" &&
		previous !== ";" &&
		previous !== "|" &&
		next !== ">" &&
		next !== "<"
	);
}

/**
 * Split a shell command at top-level line-break control operators while
 * retaining each operator on the line before the continuation prompt. Pipelines
 * and fallback operators stay inline so a pipeline is not visually fragmented.
 *
 * This is intentionally conservative. It is a display formatter, not a full
 * Bash parser. Operators inside quotes, escaped text, comments, nested groups,
 * command substitutions, and [[ tests ]] are left untouched.
 */
export function splitShellCommand(command: string): ShellCommandPart[] {
	const parts: ShellCommandPart[] = [];
	let start = 0;
	let quote: "single" | "double" | undefined;
	let inBackticks = false;
	let inComment = false;
	let escaped = false;
	let parenDepth = 0;
	let braceDepth = 0;
	let testDepth = 0;

	for (let index = 0; index < command.length; index++) {
		const char = command[index];

		if (inComment) {
			if (char === "\n") inComment = false;
			continue;
		}

		if (escaped) {
			escaped = false;
			continue;
		}

		if (char === "\\" && quote !== "single") {
			escaped = true;
			continue;
		}

		if (quote === "single") {
			if (char === "'") quote = undefined;
			continue;
		}

		if (quote === "double") {
			if (char === '"') quote = undefined;
			continue;
		}

		if (inBackticks) {
			if (char === "`") inBackticks = false;
			continue;
		}

		if (char === "'") {
			quote = "single";
			continue;
		}
		if (char === '"') {
			quote = "double";
			continue;
		}
		if (char === "`") {
			inBackticks = true;
			continue;
		}
		if (char === "#" && (index === 0 || /\s/.test(command[index - 1] ?? ""))) {
			inComment = true;
			continue;
		}

		if (command.startsWith("[[", index)) {
			testDepth++;
			index++;
			continue;
		}
		if (testDepth > 0) {
			if (command.startsWith("]]", index)) {
				testDepth--;
				index++;
			}
			continue;
		}

		if (char === "(") {
			parenDepth++;
			continue;
		}
		if (char === ")" && parenDepth > 0) {
			parenDepth--;
			continue;
		}
		if (char === "{") {
			braceDepth++;
			continue;
		}
		if (char === "}" && braceDepth > 0) {
			braceDepth--;
			continue;
		}
		if (parenDepth > 0 || braceDepth > 0) continue;

		let connector: string | undefined;
		if (command.startsWith("&&", index)) {
			connector = "&&";
		} else if (char === ";" && isSafeSemicolon(command, index)) {
			connector = ";";
		} else if (char === "&" && isStandaloneAmpersand(command, index)) {
			connector = "&";
		}

		if (!connector || !LINE_BREAK_CONNECTORS.has(connector)) continue;

		parts.push({ text: command.slice(start, index), connector });
		index += connector.length - 1;
		start = index + 1;
	}

	parts.push({ text: command.slice(start) });
	return parts;
}

function normalizePart(text: string): string {
	// Remove separator whitespace while preserving indentation after an
	// existing newline in a multiline shell command.
	const leadingNewlines = text.match(/^(?:[ \t]*\r?\n)+/);
	const withoutLeadingSeparators = leadingNewlines ? text.slice(leadingNewlines[0].length) : text.trimStart();
	return withoutLeadingSeparators.trimEnd();
}

function connectorSuffix(connector: string): string {
	return connector === ";" ? connector : ` ${connector}`;
}

export function formatShellCommand(command: string): string[] {
	const lines: string[] = [];

	for (const [partIndex, part] of splitShellCommand(command).entries()) {
		const physicalLines = normalizePart(part.text).split(/\r?\n/);
		for (const [lineIndex, physicalLine] of physicalLines.entries()) {
			const prefix = partIndex === 0 && lineIndex === 0 ? "$ " : "> ";
			lines.push(`${prefix}${physicalLine}`);
		}

		if (part.connector) {
			lines[lines.length - 1] += connectorSuffix(part.connector);
		}
	}

	return lines;
}
