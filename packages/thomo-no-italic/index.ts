import { Theme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PATCH_MARKER = Symbol.for("pi.no-italic.theme-patched");

type PatchedThemePrototype = Theme & Record<PropertyKey, unknown>;

/**
 * Disable the TUI's italic style globally without changing message content.
 *
 * Pi routes Markdown emphasis, blockquotes, thinking labels, and the small
 * number of other interactive italic styles through Theme.prototype.italic().
 * Patching that single display seam keeps both user and assistant messages
 * unchanged in session history while removing the terminal italic SGR code.
 */
export default function noItalic(_pi: ExtensionAPI): void {
	const prototype = Theme.prototype as PatchedThemePrototype;
	if (prototype[PATCH_MARKER]) return;

	prototype.italic = (text: string): string => text;
	Object.defineProperty(prototype, PATCH_MARKER, {
		configurable: false,
		enumerable: false,
		value: true,
		writable: false,
	});
}
