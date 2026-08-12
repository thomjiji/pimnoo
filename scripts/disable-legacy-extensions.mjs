import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join, relative } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const dryRun = process.argv.includes("--dry-run");
const legacyPaths = [
	["extensions/auto-title", "auto-title"],
	["extensions/bash-readable.ts", "bash-readable.ts"],
	["extensions/bash-readable", "bash-readable-helper"],
	["extensions/export-md.ts", "export-md.ts"],
	["extensions/no-italic.ts", "no-italic.ts"],
];
const backupRoot = join(agentDir, "extensions-disabled", "pimono");

let moved = 0;
for (const [sourceRelative, backupName] of legacyPaths) {
	const source = join(agentDir, sourceRelative);
	if (!existsSync(source)) continue;
	const destination = join(backupRoot, backupName);
	if (existsSync(destination)) {
		throw new Error(`Refusing to overwrite an existing backup: ${destination}`);
	}
	if (dryRun) {
		console.log(`${relative(agentDir, source)} -> ${relative(agentDir, destination)}`);
		continue;
	}
	await mkdir(backupRoot, { recursive: true });
	await rename(source, destination);
	console.log(`${relative(agentDir, source)} -> ${relative(agentDir, destination)}`);
	moved++;
}

if (dryRun) {
	console.log("Dry run complete. No legacy extension was moved.");
} else {
	console.log(moved === 0 ? "No legacy pimono extensions found." : `Moved ${moved} legacy pimono extension path(s) out of automatic discovery.`);
}
