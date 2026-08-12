import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("declares one umbrella Pi package and only the extension resource tree", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.equal(manifest.name, "pimono");
	assert.equal(manifest.private, true);
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.deepEqual(manifest.pi.extensions, ["./extensions"]);
	assert.equal(manifest.dependencies, undefined);
	assert.equal(manifest.devDependencies, undefined);

	const expectedEntrypoints = [
		"auto-title/index.ts",
		"bash-readable/index.ts",
		"export-md/index.ts",
		"no-italic/index.ts",
	];
	const discoveredEntrypoints: string[] = [];
	for (const extensionName of readdirSync(join(root, "extensions"))) {
		const extensionDir = join(root, "extensions", extensionName);
		if (!statSync(extensionDir).isDirectory()) continue;
		for (const fileName of readdirSync(extensionDir)) {
			if (fileName === "index.ts") discoveredEntrypoints.push(`${extensionName}/${fileName}`);
		}
	}
	assert.deepEqual(discoveredEntrypoints.sort(), expectedEntrypoints.sort());
	assert.equal(statSync(join(root, "extensions", "bash-readable", "format.ts")).isFile(), true);
});
