/**
 * Render chained Bash commands on separate lines without changing execution.
 *
 * Example:
 *   $ cd /workspace
 *   > npm test
 *   > npm run lint
 *
 * Breakable top-level shell control operators remain visible at the end of
 * each line. Pipelines and fallback operators stay inline. The command passed
 * to the original Bash tool remains unchanged.
 */

import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatShellCommand } from "./format.ts";

export default function readableBashExtension(pi: ExtensionAPI) {
	// Match Pi's built-in tool behavior and delegate execution to it. The
	// extension changes only renderCall, so output, timeouts, cancellation, and
	// truncation keep the built-in implementation. Keep this instance only for
	// static metadata: an extension can run in a child session whose cwd differs
	// from process.cwd() (for example, a subagent worktree).
	const bashMetadata = createBashTool(".");

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: bashMetadata.description,
		parameters: bashMetadata.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const bash = createBashTool(ctx.cwd);
			return bash.execute(toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			const lines = formatShellCommand(args.command);
			let text = lines
				.map((line, index) => {
					const prefixLength = 2;
					return theme.fg("toolTitle", theme.bold(line.slice(0, prefixLength))) +
						theme.fg("accent", line.slice(prefixLength));
				})
				.join("\n");

			if (args.timeout !== undefined) {
				text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
			}

			return new Text(text, 0, 0);
		},
	});
}
