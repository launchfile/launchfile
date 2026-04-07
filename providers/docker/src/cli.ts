#!/usr/bin/env node
/**
 * CLI entry point for the Launchfile Docker provider.
 *
 * Usage:
 *   launchfile up <slug|path|url> [--detach] [--dry-run]
 *   launchfile down [--destroy]
 *   launchfile status [slug]
 *   launchfile logs [--follow]
 *   launchfile list
 */

import { dockerUp, dockerDown, dockerStatus, dockerLogs, dockerList } from "./provider.js";

const args = process.argv.slice(2);
const command = args[0];

function hasFlag(flag: string): boolean {
	return args.includes(`--${flag}`);
}

function getPositional(index: number): string | undefined {
	// Skip flags
	let pos = 0;
	for (let i = 1; i < args.length; i++) {
		if (!args[i]!.startsWith("--")) {
			if (pos === index) return args[i];
			pos++;
		}
	}
	return undefined;
}

async function main(): Promise<void> {
	switch (command) {
		case "up": {
			const source = getPositional(0);
			if (!source) {
				console.error("Usage: launchfile up <slug|path|url>");
				console.error("");
				console.error("Examples:");
				console.error("  launchfile up ghost           # from catalog");
				console.error("  launchfile up ./Launchfile    # local file");
				console.error("  launchfile up --dry-run ghost # preview only");
				process.exit(1);
			}
			await dockerUp(source, {
				detach: hasFlag("detach"),
				dryRun: hasFlag("dry-run"),
				yes: hasFlag("yes") || hasFlag("y"),
			});
			break;
		}

		case "down":
			await dockerDown({
				destroy: hasFlag("destroy"),
				slug: getPositional(0),
			});
			break;

		case "status":
			await dockerStatus(getPositional(0));
			break;

		case "logs":
			await dockerLogs({
				follow: hasFlag("follow") || hasFlag("f"),
				slug: getPositional(0),
			});
			break;

		case "list":
		case "ls":
			await dockerList();
			break;

		default:
			console.log("Launchfile Docker Provider");
			console.log("");
			console.log("Usage:");
			console.log("  launchfile up <slug|path|url>  Start an app");
			console.log("  launchfile down [--destroy]    Stop (and optionally destroy)");
			console.log("  launchfile status [slug]       Show running status");
			console.log("  launchfile logs [--follow]     View logs");
			console.log("  launchfile list                List managed apps");
			console.log("");
			console.log("Examples:");
			console.log("  npx launchfile up ghost");
			console.log("  npx launchfile up audiobookshelf");
			console.log("  npx launchfile down --destroy");
			break;
	}
}

main().catch((err: Error) => {
	console.error(`\nError: ${err.message}`);
	process.exit(1);
});
