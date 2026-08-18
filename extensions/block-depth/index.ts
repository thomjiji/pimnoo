/**
 * Add terminal-friendly depth treatments to Pi's semantic background blocks.
 * Switch at runtime with:
 *
 *   /block-depth hard|half|deep|off
 *
 * This intentionally patches the shared Box rendering seam. It only touches
 * boxes whose callbacks explicitly request Pi's user/custom/tool message
 * backgrounds; selectors, editors, and ordinary layout boxes stay native.
 */

import { Theme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";

type DepthMode = "hard" | "half" | "deep" | "off";
type ThemeBg = "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
type RGB = { r: number; g: number; b: number };

type RuntimeBox = {
	bgFn?: (text: string) => string;
};

type PatchState = {
	mode: DepthMode;
	owner: object;
	originalRender: (width: number) => string[];
	patchedRender: (width: number) => string[];
};

const PATCH_MARKER = Symbol.for("pimnoo.block-depth");
const SAMPLE = "pimnoo-block-depth-sample";
const BLOCK_BACKGROUNDS: ThemeBg[] = [
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
];
const DEPTH_MODES = new Set<DepthMode>(["hard", "half", "deep", "off"]);
const HARD_SIDE_WIDTH = 3;
const HALF_SIDE_WIDTH = 2;
const HALF_TOP_CUTOUT = "▄▖";

const BASIC_ANSI_COLORS: RGB[] = [
	{ r: 0, g: 0, b: 0 },
	{ r: 128, g: 0, b: 0 },
	{ r: 0, g: 128, b: 0 },
	{ r: 128, g: 128, b: 0 },
	{ r: 0, g: 0, b: 128 },
	{ r: 128, g: 0, b: 128 },
	{ r: 0, g: 128, b: 128 },
	{ r: 192, g: 192, b: 192 },
	{ r: 128, g: 128, b: 128 },
	{ r: 255, g: 0, b: 0 },
	{ r: 0, g: 255, b: 0 },
	{ r: 255, g: 255, b: 0 },
	{ r: 0, g: 0, b: 255 },
	{ r: 255, g: 0, b: 255 },
	{ r: 0, g: 255, b: 255 },
	{ r: 255, g: 255, b: 255 },
];

function xtermColor(index: number): RGB {
	if (index < 16) return BASIC_ANSI_COLORS[Math.max(0, index)] ?? BASIC_ANSI_COLORS[0];
	if (index < 232) {
		const value = index - 16;
		const levels = [0, 95, 135, 175, 215, 255];
		return {
			r: levels[Math.floor(value / 36)] ?? 0,
			g: levels[Math.floor((value % 36) / 6)] ?? 0,
			b: levels[value % 6] ?? 0,
		};
	}
	const gray = 8 + (Math.min(255, index) - 232) * 10;
	return { r: gray, g: gray, b: gray };
}

function parseBackgroundColor(ansi: string): RGB | undefined {
	const trueColor = ansi.match(/48;2;(\d+);(\d+);(\d+)m/);
	if (trueColor) {
		return { r: Number(trueColor[1]), g: Number(trueColor[2]), b: Number(trueColor[3]) };
	}
	const indexed = ansi.match(/48;5;(\d+)m/);
	if (indexed) return xtermColor(Number(indexed[1]));
	const basic = ansi.match(/\[(?:10([0-7])|4([0-7]))m/);
	if (!basic) return undefined;
	return BASIC_ANSI_COLORS[Number(basic[1] ?? basic[2]) + (basic[1] ? 8 : 0)];
}

function shade(color: RGB, factor: number): RGB {
	return {
		r: Math.round(color.r * factor),
		g: Math.round(color.g * factor),
		b: Math.round(color.b * factor),
	};
}

function background(text: string, color: RGB): string {
	return `\x1b[48;2;${color.r};${color.g};${color.b}m${text}\x1b[49m`;
}

function foreground(text: string, color: RGB): string {
	return `\x1b[38;2;${color.r};${color.g};${color.b}m${text}\x1b[39m`;
}

function semanticBackgroundColor(box: RuntimeBox): RGB | undefined {
	if (!box.bgFn) return undefined;

	// Observe one synchronous sample through the public Theme class. This ties
	// eligibility to the semantic key actually used, rather than callback source
	// spelling or color equality (which can collide with menu backgrounds).
	const originalThemeBg = Theme.prototype.bg;
	const semanticOutputs = new Set<string>();
	const observedThemeBg = function observeSemanticBackground(
		this: Theme,
		name: Parameters<Theme["bg"]>[0],
		text: string,
	): string {
		const output = originalThemeBg.call(this, name, text);
		if (BLOCK_BACKGROUNDS.includes(name as ThemeBg)) semanticOutputs.add(output);
		return output;
	};

	Theme.prototype.bg = observedThemeBg;
	let renderedSample: string;
	try {
		renderedSample = box.bgFn(SAMPLE);
	} finally {
		Theme.prototype.bg = originalThemeBg;
	}
	return semanticOutputs.has(renderedSample) ? parseBackgroundColor(renderedSample) : undefined;
}

function isDepthMode(value: string): value is DepthMode {
	return DEPTH_MODES.has(value as DepthMode);
}

function renderHard(lines: string[], faceWidth: number, shadow: RGB): string[] {
	const [firstLine, ...remainingLines] = lines;
	if (!firstLine) return lines;
	return [
		firstLine + " ".repeat(HARD_SIDE_WIDTH),
		...remainingLines.map((line) => line + background(" ".repeat(HARD_SIDE_WIDTH), shadow)),
		" ".repeat(HARD_SIDE_WIDTH) + background(" ".repeat(faceWidth), shadow),
	];
}

function renderHalf(lines: string[], faceWidth: number, shadow: RGB): string[] {
	const [firstLine, ...remainingLines] = lines;
	if (!firstLine) return lines;
	const bottom = "▝" + "▀".repeat(Math.max(0, faceWidth - 1)) + "▘";
	return [
		firstLine + foreground(HALF_TOP_CUTOUT, shadow),
		...remainingLines.map((line) => line + background(" ", shadow) + foreground("▌", shadow)),
		" " + foreground(bottom, shadow),
	];
}

function renderDeep(lines: string[], faceWidth: number, near: RGB, far: RGB): string[] {
	return [
		...lines.map((line) => line + background(" ", near) + background(" ", far)),
		" " + background(" ".repeat(faceWidth), near) + background(" ", far),
		"  " + background(" ".repeat(faceWidth), far),
	];
}

function installPatch(owner: object): PatchState {
	const prototype = Box.prototype as typeof Box.prototype & Record<PropertyKey, unknown>;
	const existing = prototype[PATCH_MARKER] as PatchState | undefined;
	if (existing) {
		existing.mode = "half";
		existing.owner = owner;
		return existing;
	}

	const originalRender = Box.prototype.render;
	const state: PatchState = { mode: "half", owner, originalRender, patchedRender: originalRender };
	const patchedRender = function renderBlockWithDepth(this: Box, width: number): string[] {
		const mode = state.mode;
		if (mode === "off") return originalRender.call(this, width);

		const faceColor = semanticBackgroundColor(this as unknown as RuntimeBox);
		if (!faceColor) return originalRender.call(this, width);

		const offset = mode === "hard" ? HARD_SIDE_WIDTH : mode === "half" ? HALF_SIDE_WIDTH : 2;
		if (width <= offset + 2) return originalRender.call(this, width);

		const faceWidth = width - offset;
		const lines = originalRender.call(this, faceWidth);
		if (lines.length === 0) return lines;

		const near = shade(faceColor, 0.58);
		if (mode === "half") return renderHalf(lines, faceWidth, near);
		if (mode === "deep") return renderDeep(lines, faceWidth, near, shade(faceColor, 0.32));
		return renderHard(lines, faceWidth, near);
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

export default function blockDepth(pi: ExtensionAPI): void {
	const owner = {};
	const state = installPatch(owner);

	pi.registerCommand("block-depth", {
		description: "Switch semantic block depth (hard, half, deep, off)",
		handler: (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (requested && !isDepthMode(requested)) {
				ctx.ui.notify("Usage: /block-depth [hard|half|deep|off]", "warning");
				return;
			}
			if (isDepthMode(requested)) state.mode = requested;
			ctx.ui.notify(`Block depth: ${state.mode}`, "info");
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
