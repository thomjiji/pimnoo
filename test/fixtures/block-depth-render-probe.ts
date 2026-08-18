import { Theme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text, visibleWidth } from "@earendil-works/pi-tui";

const probeTheme = new Theme(
	{ text: "", thinkingXhigh: "" } as ConstructorParameters<typeof Theme>[0],
	{ selectedBg: 0, userMessageBg: 22 } as ConstructorParameters<typeof Theme>[1],
	"256color",
);
const semanticBackgroundName = "userMessageBg";
const userMessageBackground = (text: string): string => probeTheme.bg(semanticBackgroundName, text);

/** Regression probe: the real Box patch renders semantic depth without changing terminal width. */
export default function blockDepthRenderProbe(_pi: ExtensionAPI): void {
	const patch = (Box.prototype as typeof Box.prototype & Record<PropertyKey, unknown>)[
		Symbol.for("pimnoo.block-depth-prototype")
	] as { mode: "hard" | "half" | "deep" | "off" } | undefined;
	if (!patch) throw new Error("block-depth patch marker is missing");
	if (patch.mode !== "half") throw new Error("block-depth did not default to half mode");

	const halfBox = new Box(1, 1, (text) => userMessageBackground(text));
	halfBox.addChild(new Text("x".repeat(37), 0, 0));
	const halfLines = halfBox.render(40);
	if (halfLines.length !== 5 || halfLines.some((line) => visibleWidth(line) !== 40)) {
		throw new Error("block-depth half mode did not reserve proportional side width");
	}
	if (!halfLines[0]?.includes("▄▖") || !halfLines.at(-1)?.includes("▝") || !halfLines.at(-1)?.includes("▘")) {
		throw new Error("block-depth half mode did not render proportional cut-out corners");
	}

	patch.mode = "hard";
	try {
		const box = new Box(1, 1, (text) => userMessageBackground(text));
		box.addChild(new Text("block-depth-render-probe", 0, 0));
		const lines = box.render(40);
		if (lines.length !== 4 || lines.some((line) => visibleWidth(line) !== 40)) {
			throw new Error("block-depth hard mode did not render a width-preserving shadow");
		}
		if (!/\x1b\[49m {3}$/.test(lines[0] ?? "") || !lines.at(-1)?.startsWith("   ")) {
			throw new Error("block-depth hard mode did not remove the top-right depth square");
		}

		const ordinaryBox = new Box(1, 1, (text) => `\x1b[48;5;22m${text}\x1b[49m`);
		ordinaryBox.addChild(new Text("ordinary-layout-box", 0, 0));
		if (ordinaryBox.render(40).length !== 3) {
			throw new Error("block-depth changed a non-semantic Box");
		}

		const nativeNarrowBox = new Box(1, 1, (text) => `\x1b[48;5;22m${text}\x1b[49m`);
		nativeNarrowBox.addChild(new Text("block-depth-render-probe", 0, 0));
		if (JSON.stringify(box.render(3)) !== JSON.stringify(nativeNarrowBox.render(3))) {
			throw new Error("block-depth did not fall back to native rendering at narrow widths");
		}
	} finally {
		patch.mode = "half";
	}
}
