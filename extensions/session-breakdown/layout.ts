/** Pi-style framing helpers for the session dashboard. */

/** Full-screen settings shared by the loading and dashboard views. */
export const FULLSCREEN_VIEW_OPTIONS = {
	overlay: true,
	overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
} as const;

/** Add the same open-top/open-bottom frame used by Pi's native full-screen views. */
export function frameWithPiBorders(lines: string[], terminalRows: number, border: string): string[] {
	const framed = [border, "", ...lines, "", border];
	if (framed.length <= terminalRows) return framed;
	if (terminalRows <= 1) return [border];
	return [...framed.slice(0, terminalRows - 1), border];
}
