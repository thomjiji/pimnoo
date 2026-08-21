import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("declares the umbrella workspace and standalone package boundaries", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.equal(manifest.name, "thomo");
	assert.equal(manifest.private, true);
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.ok(manifest.files.includes("LICENSE"));
	assert.deepEqual(manifest.workspaces, ["packages/*"]);
	assert.deepEqual(manifest.pi.extensions, ["./packages/*/index.ts", "!packages/thomo-delegate/index.ts"]);
	assert.equal(manifest.dependencies, undefined);
	assert.equal(manifest.devDependencies, undefined);

	const expectedEntrypoints = [
		"thomo-auto-title/index.ts",
		"thomo-bash-readable/index.ts",
		"thomo-block-style/index.ts",
		"thomo-delegate/index.ts",
		"thomo-export-md/index.ts",
		"thomo-no-italic/index.ts",
		"thomo-reply-anchor/index.ts",
	];
	const discoveredEntrypoints: string[] = [];
	for (const packageName of readdirSync(join(root, "packages"))) {
		const packageDir = join(root, "packages", packageName);
		if (!statSync(packageDir).isDirectory()) continue;
		const packageManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
		assert.equal(packageManifest.name, packageName);
		assert.equal(packageManifest.private, true);
		assert.deepEqual(packageManifest.pi?.extensions, packageName === "thomo-delegate" ? [] : ["./index.ts"]);
		for (const fileName of readdirSync(packageDir)) {
			if (fileName === "index.ts") discoveredEntrypoints.push(`${packageName}/${fileName}`);
		}
	}
	assert.deepEqual(discoveredEntrypoints.sort(), expectedEntrypoints.sort());
	assert.equal(statSync(join(root, "packages", "shared"), { throwIfNoEntry: false }), undefined);
	assert.equal(statSync(join(root, "packages", "thomo-bash-readable", "format.ts")).isFile(), true);
});
