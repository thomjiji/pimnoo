import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("declares the umbrella package and standalone package boundaries", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.equal(manifest.name, "pimono");
	assert.equal(manifest.private, true);
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.ok(manifest.files.includes("LICENSE"));
	assert.deepEqual(manifest.pi.extensions, ["./extensions"]);
	assert.equal(manifest.dependencies, undefined);
	assert.equal(manifest.devDependencies, undefined);

	const expectedEntrypoints = [
		"auto-title/index.ts",
		"bash-readable/index.ts",
		"block-style/index.ts",
		"delegate/index.ts",
		"export-md/index.ts",
		"no-italic/index.ts",
		"reply-anchor/index.ts",
	];
	const discoveredEntrypoints: string[] = [];
	for (const extensionName of readdirSync(join(root, "extensions"))) {
		const extensionDir = join(root, "extensions", extensionName);
		if (!statSync(extensionDir).isDirectory()) continue;
		const extensionManifest = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8"));
		assert.equal(extensionManifest.private, true);
		assert.deepEqual(extensionManifest.pi?.extensions, ["./index.ts"]);
		for (const fileName of readdirSync(extensionDir)) {
			if (fileName === "index.ts") discoveredEntrypoints.push(`${extensionName}/${fileName}`);
		}
	}
	assert.deepEqual(discoveredEntrypoints.sort(), expectedEntrypoints.sort());
	assert.equal(statSync(join(root, "extensions", "shared"), { throwIfNoEntry: false }), undefined);
	assert.equal(statSync(join(root, "extensions", "bash-readable", "format.ts")).isFile(), true);
});
