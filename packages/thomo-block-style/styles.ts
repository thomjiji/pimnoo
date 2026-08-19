import { background, foreground, shade, stripBackground, type RGB, type ThemeBg } from "./colors.ts";

export type BlockStyle = "half" | "half-hatch" | "full" | "deep" | "outline" | "rail" | "spotlight" | "off";
export type ActiveBlockStyle = Exclude<BlockStyle, "off">;

export type BlockStyleContext = {
	lines: string[];
	faceWidth: number;
	faceColor: RGB;
	nearColor: RGB;
	farColor: RGB;
	semanticName: ThemeBg;
};

type BlockStyleDefinition = {
	reservedWidth: number;
	render: (context: BlockStyleContext) => string[];
};

const FULL_SIDE_WIDTH = 3;
const HALF_SIDE_WIDTH = 2;
const RAIL_WIDTH = 1;
const RAIL_GLYPH = "█";
const HALF_TOP_CUTOUT = "▄▖";
const HALF_HATCH_GLYPH = "▚";

function renderFull(lines: string[], faceWidth: number, shadow: RGB): string[] {
	const [firstLine, ...remainingLines] = lines;
	if (!firstLine) return lines;
	return [
		firstLine + " ".repeat(FULL_SIDE_WIDTH),
		...remainingLines.map((line) => line + background(" ".repeat(FULL_SIDE_WIDTH), shadow)),
		" ".repeat(FULL_SIDE_WIDTH) + background(" ".repeat(faceWidth), shadow),
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

function renderHalfHatch(lines: string[], faceWidth: number, shadow: RGB): string[] {
	const side = foreground(HALF_HATCH_GLYPH.repeat(HALF_SIDE_WIDTH), shadow);
	const top = " ".repeat(HALF_SIDE_WIDTH);
	const bottom = foreground(HALF_HATCH_GLYPH.repeat(faceWidth + 1), shadow);
	const [firstLine, ...remainingLines] = lines;
	if (!firstLine) return lines;
	return [firstLine + top, ...remainingLines.map((line) => line + side), " " + bottom];
}

function renderDeep(lines: string[], faceWidth: number, near: RGB, far: RGB): string[] {
	return [
		...lines.map((line) => line + background(" ", near) + background(" ", far)),
		" " + background(" ".repeat(faceWidth), near) + background(" ", far),
		"  " + background(" ".repeat(faceWidth), far),
	];
}

function renderOutline(lines: string[], faceWidth: number, border: RGB): string[] {
	const cleanLines = lines.map(stripBackground);
	if (cleanLines.length < 2) {
		return cleanLines.map((line) => foreground("┃", border) + line + foreground("┃", border));
	}

	const top = foreground(`┏${"━".repeat(faceWidth)}┓`, border);
	const bottom = foreground(`┗${"━".repeat(faceWidth)}┛`, border);
	const middle = cleanLines.slice(1, -1).map(
		(line) => foreground("┃", border) + line + foreground("┃", border),
	);
	return [top, ...middle, bottom];
}

function renderRail(lines: string[], accent: RGB): string[] {
	return lines.map((line) => foreground(RAIL_GLYPH, accent) + line);
}

function renderSpotlight(lines: string[], faceColor: RGB, semanticName: ThemeBg): string[] {
	const active = semanticName === "toolPendingBg";
	const accent = shade(faceColor, active ? 1.25 : 0.78);
	return lines.map((line) => foreground("█", accent) + line);
}

/**
 * The style registry is the internal seam for new block treatments. Each style
 * owns its width reservation and line geometry; Box patching stays unaware of
 * whether a treatment is depth, outline, rail, or a future focus style.
 */
export const BLOCK_STYLES: Record<ActiveBlockStyle, BlockStyleDefinition> = {
	half: {
		reservedWidth: HALF_SIDE_WIDTH,
		render: ({ lines, faceWidth, nearColor }) => renderHalf(lines, faceWidth, nearColor),
	},
	"half-hatch": {
		reservedWidth: HALF_SIDE_WIDTH,
		render: ({ lines, faceWidth, nearColor }) => renderHalfHatch(lines, faceWidth, nearColor),
	},
	full: {
		reservedWidth: FULL_SIDE_WIDTH,
		render: ({ lines, faceWidth, nearColor }) => renderFull(lines, faceWidth, nearColor),
	},
	deep: {
		reservedWidth: 2,
		render: ({ lines, faceWidth, nearColor, farColor }) => renderDeep(lines, faceWidth, nearColor, farColor),
	},
	outline: {
		reservedWidth: 2,
		render: ({ lines, faceWidth, faceColor }) => renderOutline(lines, faceWidth, shade(faceColor, 1.25)),
	},
	rail: {
		reservedWidth: RAIL_WIDTH,
		render: ({ lines, faceColor }) => renderRail(lines, shade(faceColor, 1.15)),
	},
	spotlight: {
		reservedWidth: 1,
		render: ({ lines, faceColor, semanticName }) => renderSpotlight(lines, faceColor, semanticName),
	},
};

export function isBlockStyle(value: string): value is BlockStyle {
	return value === "off" || Object.hasOwn(BLOCK_STYLES, value);
}
