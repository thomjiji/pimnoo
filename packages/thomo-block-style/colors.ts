import { Theme } from "@earendil-works/pi-coding-agent";

export type ThemeBg = "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
export type RGB = { r: number; g: number; b: number };

export type SemanticBackground = {
	name: ThemeBg;
	color: RGB;
};

type RuntimeBox = {
	bgFn?: (text: string) => string;
};

const SAMPLE = "thomo-block-style-sample";
const BLOCK_BACKGROUNDS: ThemeBg[] = [
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
];

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

export function parseBackgroundColor(ansi: string): RGB | undefined {
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

export function shade(color: RGB, factor: number): RGB {
	const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
	return {
		r: clamp(color.r * factor),
		g: clamp(color.g * factor),
		b: clamp(color.b * factor),
	};
}

export function background(text: string, color: RGB): string {
	return `\x1b[48;2;${color.r};${color.g};${color.b}m${text}\x1b[49m`;
}

export function foreground(text: string, color: RGB): string {
	return `\x1b[38;2;${color.r};${color.g};${color.b}m${text}\x1b[39m`;
}

/** Remove the face fill while preserving text styling for outline-like styles. */
export function stripBackground(ansi: string): string {
	return ansi
		.replace(/\x1b\[48;(?:2;\d+;\d+;\d+|5;\d+|\d+)m/g, "")
		.replace(/\x1b\[49m/g, "");
}

/** Observe the semantic Theme key used by a Box without relying on callback source or color equality. */
export function semanticBackground(box: RuntimeBox): SemanticBackground | undefined {
	if (!box.bgFn) return undefined;

	const originalThemeBg = Theme.prototype.bg;
	const semanticOutputs = new Map<string, ThemeBg>();
	const observedThemeBg = function observeSemanticBackground(
		this: Theme,
		name: Parameters<Theme["bg"]>[0],
		text: string,
	): string {
		const output = originalThemeBg.call(this, name, text);
		if (BLOCK_BACKGROUNDS.includes(name as ThemeBg)) semanticOutputs.set(output, name as ThemeBg);
		return output;
	};

	Theme.prototype.bg = observedThemeBg;
	let renderedSample: string;
	try {
		renderedSample = box.bgFn(SAMPLE);
	} finally {
		Theme.prototype.bg = originalThemeBg;
	}
	const name = semanticOutputs.get(renderedSample);
	const color = parseBackgroundColor(renderedSample);
	return name && color ? { name, color } : undefined;
}
