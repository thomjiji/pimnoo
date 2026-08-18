/**
 * Apply terminal-friendly styles to Pi's semantic message blocks.
 * Switch at runtime with:
 *
 *   /block-style half|full|deep|outline|rail|spotlight|off
 *
 * This intentionally patches the shared Box rendering seam. It only touches
 * boxes whose callbacks explicitly request Pi's user/custom/tool message
 * backgrounds; selectors, editors, and ordinary layout boxes stay native.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import { semanticBackground, shade } from "./colors.ts";
import { BLOCK_STYLES, isBlockStyle, type BlockStyle } from "./styles.ts";

type PatchState = {
	style: BlockStyle;
	owner: object;
	originalRender: (width: number) => string[];
	patchedRender: (width: number) => string[];
};

const PATCH_MARKER = Symbol.for("pimnoo.block-style");

function installPatch(owner: object): PatchState {
	const prototype = Box.prototype as typeof Box.prototype & Record<PropertyKey, unknown>;
	const existing = prototype[PATCH_MARKER] as PatchState | undefined;
	if (existing) {
		existing.style = "half";
		existing.owner = owner;
		return existing;
	}

	const originalRender = Box.prototype.render;
	const state: PatchState = { style: "half", owner, originalRender, patchedRender: originalRender };
	const patchedRender = function renderStyledBlock(this: Box, width: number): string[] {
		const style = state.style;
		if (style === "off") return originalRender.call(this, width);

		const semantic = semanticBackground(this as { bgFn?: (text: string) => string });
		if (!semantic) return originalRender.call(this, width);

		const definition = BLOCK_STYLES[style];
		if (width <= definition.reservedWidth + 2) return originalRender.call(this, width);

		const faceWidth = width - definition.reservedWidth;
		const lines = originalRender.call(this, faceWidth);
		if (lines.length === 0) return lines;

		return definition.render({
			lines,
			faceWidth,
			faceColor: semantic.color,
			nearColor: shade(semantic.color, 0.58),
			farColor: shade(semantic.color, 0.32),
			semanticName: semantic.name,
		});
	};
	state.patchedRender = patchedRender;
	Box.prototype.render = patchedRender;

	Object.defineProperty(prototype, PATCH_MARKER, {
		configurable: true,
		enumerable: false,
		value: state,
		writable: false,
	});
	return state;
}

export default function blockStyle(pi: ExtensionAPI): void {
	const owner = {};
	const state = installPatch(owner);

	pi.registerCommand("block-style", {
		description: "Switch semantic block style (half, full, deep, outline, rail, spotlight, off)",
		handler: (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (requested && !isBlockStyle(requested)) {
				ctx.ui.notify("Usage: /block-style [half|full|deep|outline|rail|spotlight|off]", "warning");
				return;
			}
			if (isBlockStyle(requested)) state.style = requested;
			ctx.ui.notify(`Block style: ${state.style}`, "info");
		},
	});

	pi.on("session_shutdown", () => {
		const prototype = Box.prototype as typeof Box.prototype & Record<PropertyKey, unknown>;
		if (state.owner !== owner) return;
		if (prototype[PATCH_MARKER] !== state || Box.prototype.render !== state.patchedRender) return;
		Box.prototype.render = state.originalRender;
		delete prototype[PATCH_MARKER];
	});
}
