import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionRoot = join(root, "extensions");
const files = [];

function collect(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) collect(path);
		else if (entry.name.endsWith(".ts")) files.push(path);
	}
}

collect(extensionRoot);
for (const file of files) {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--check", file], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${relative(root, file)}\n`);
		process.exit(result.status ?? 1);
	}
}

console.log(`Checked ${files.length} TypeScript extension files for syntax.`);
