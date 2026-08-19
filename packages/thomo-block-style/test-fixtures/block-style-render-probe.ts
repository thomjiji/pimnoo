import { Theme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text, visibleWidth } from "@earendil-works/pi-tui";

const probeTheme = new Theme(
	{ text: "", thinkingXhigh: "" } as ConstructorParameters<typeof Theme>[0],
	{ selectedBg: 0, userMessageBg: 22, toolPendingBg: 214 } as ConstructorParameters<typeof Theme>[1],
	"256color",
);
const semanticBackgroundName = "userMessageBg";
const userMessageBackground = (text: string): string => probeTheme.bg(semanticBackgroundName, text);
const pendingToolBackground = (text: string): string => probeTheme.bg("toolPendingBg", text);

type BlockStyle = "half" | "half-hatch" | "full" | "deep" | "outline" | "rail" | "spotlight" | "off";

/** Regression probe: the real Box patch renders styles without changing terminal width. */
export default function blockStyleRenderProbe(pi: ExtensionAPI): void {
	pi.registerCommand("block-style-render-probe", {
		description: "Run the block-style render probe",
		handler: () => runBlockStyleProbe(),
	});
}

function runBlockStyleProbe(): void {
	const patch = (Box.prototype as typeof Box.prototype & Record<PropertyKey, unknown>)[
		Symbol.for("thomo.block-style")
	] as { style: BlockStyle } | undefined;
	if (!patch) throw new Error("block-style patch marker is missing");
	if (patch.style !== "half") throw new Error("block-style did not default to half style");

	const halfBox = new Box(1, 1, (text) => userMessageBackground(text));
	halfBox.addChild(new Text("x".repeat(37), 0, 0));
	const halfLines = halfBox.render(40);
	if (halfLines.length !== 5 || halfLines.some((line) => visibleWidth(line) !== 40)) {
		throw new Error("block-style half mode did not reserve proportional side width");
	}
	if (!halfLines[0]?.includes("▄▖") || !halfLines.at(-1)?.includes("▝") || !halfLines.at(-1)?.includes("▘")) {
		throw new Error("block-style half mode did not render proportional cut-out corners");
	}

	patch.style = "half-hatch";
	const halfHatchBox = new Box(1, 1, (text) => userMessageBackground(text));
	halfHatchBox.addChild(new Text("x".repeat(37), 0, 0));
	const halfHatchLines = halfHatchBox.render(40);
	if (halfHatchLines.length !== 5 || halfHatchLines.some((line) => visibleWidth(line) !== 40)) {
		throw new Error("block-style half-hatch mode did not reserve proportional side width");
	}
	if (halfHatchLines[0]?.includes("░") || halfHatchLines.slice(1).some((line) => !line.includes("░")) || halfHatchLines.some((line) => /[▄▖▌▝▀▘]/u.test(line))) {
		throw new Error("block-style half-hatch mode did not render a unified shade texture");
	}
	if (halfHatchLines[0]?.includes("░")) {
		throw new Error("block-style half-hatch mode did not cut out the full upper-right square");
	}

	patch.style = "full";
	try {
		const fullBox = new Box(1, 1, (text) => userMessageBackground(text));
		fullBox.addChild(new Text("block-style-render-probe", 0, 0));
		const fullLines = fullBox.render(40);
		if (fullLines.length !== 4 || fullLines.some((line) => visibleWidth(line) !== 40)) {
			throw new Error("block-style full mode did not render a width-preserving shadow");
		}
		if (!/\x1b\[49m {3}$/.test(fullLines[0] ?? "") || !fullLines.at(-1)?.startsWith("   ")) {
			throw new Error("block-style full mode did not remove the top-right depth square");
		}

		patch.style = "outline";
		const outlineBox = new Box(1, 1, (text) => userMessageBackground(text));
		outlineBox.addChild(new Text("outline", 0, 0));
		const outlineLines = outlineBox.render(40);
		if (outlineLines.length !== 3 || outlineLines.some((line) => visibleWidth(line) !== 40)) {
			throw new Error("block-style outline did not preserve terminal width");
		}
		if (!outlineLines[0]?.includes("┏") || !outlineLines[0]?.includes("┓") || !outlineLines.at(-1)?.includes("┗")) {
			throw new Error("block-style outline did not render square heavy corners");
		}
		if (!outlineLines[1]?.includes("┃") || !outlineLines.some((line) => line.includes("━")) || outlineLines.some((line) => line.includes("\x1b[48;"))) {
			throw new Error("block-style outline did not remove the semantic face fill");
		}

		patch.style = "rail";
		const railBox = new Box(1, 1, (text) => userMessageBackground(text));
		railBox.addChild(new Text("rail", 0, 0));
		const railLines = railBox.render(40);
		if (railLines.length !== 3 || railLines.some((line) => visibleWidth(line) !== 40)) {
			throw new Error("block-style rail did not preserve terminal width");
		}
		if (!railLines[1]?.includes("█") || railLines.some((line) => line.includes("┃┃")) || !railLines.some((line) => line.includes("\x1b[48;"))) {
			throw new Error("block-style rail did not preserve the semantic face fill");
		}

		patch.style = "spotlight";
		const quietSpotlightBox = new Box(1, 1, (text) => userMessageBackground(text));
		quietSpotlightBox.addChild(new Text("quiet", 0, 0));
		const quietSpotlightLines = quietSpotlightBox.render(40);
		if (!quietSpotlightLines[1]?.includes("█") || !quietSpotlightLines.some((line) => line.includes("\x1b[48;"))) {
			throw new Error("block-style spotlight did not preserve completed block fills");
		}
		const activeSpotlightBox = new Box(1, 1, (text) => pendingToolBackground(text));
		activeSpotlightBox.addChild(new Text("active", 0, 0));
		const activeSpotlightLines = activeSpotlightBox.render(40);
		if (!activeSpotlightLines[1]?.includes("█") || !activeSpotlightLines.some((line) => line.includes("\x1b[48;"))) {
			throw new Error("block-style spotlight did not emphasize pending blocks");
		}

		const ordinaryBox = new Box(1, 1, (text) => `\x1b[48;5;22m${text}\x1b[49m`);
		ordinaryBox.addChild(new Text("ordinary-layout-box", 0, 0));
		if (ordinaryBox.render(40).length !== 3) {
			throw new Error("block-style changed a non-semantic Box");
		}

		patch.style = "outline";
		const nativeNarrowBox = new Box(1, 1, (text) => `\x1b[48;5;22m${text}\x1b[49m`);
		nativeNarrowBox.addChild(new Text("outline", 0, 0));
		if (JSON.stringify(outlineBox.render(4)) !== JSON.stringify(nativeNarrowBox.render(4))) {
			throw new Error("block-style did not fall back to native rendering at narrow widths");
		}
	} finally {
		patch.style = "half";
	}
}
