#!/usr/bin/env bun
/**
 * CLI entry point for the macOS dev provider.
 *
 * Usage:
 *   launch up [--with-optional] [--no-build] [--dry-run]
 *   launch down [--destroy]
 *   launch status
 *   launch env [component]
 */

import { launchUp, launchDown, launchStatus, launchEnv } from "./provider.js";

const args = process.argv.slice(2);
const command = args[0];

function hasFlag(flag: string): boolean {
	return args.includes(`--${flag}`);
}

function getArg(index: number): string | undefined {
	return args[index];
}

async function main(): Promise<void> {
	switch (command) {
		case "up":
			await launchUp({
				withOptional: hasFlag("with-optional"),
				noBuild: hasFlag("no-build"),
				dryRun: hasFlag("dry-run"),
				detach: hasFlag("detach"),
			});
			break;

		case "down":
			await launchDown({
				destroy: hasFlag("destroy"),
			});
			break;

		case "status":
			await launchStatus();
			break;

		case "env":
			await launchEnv({
				component: getArg(1),
			});
			break;

		default:
			console.log(`launch — macOS dev provider for Launchfile

Usage:
  launch up [--with-optional] [--no-build] [--dry-run]
    Provision resources, install deps, and start the app.

  launch down [--destroy]
    Stop processes. --destroy also drops databases and cleans up.

  launch status
    Show status of components and resources.

  launch env [component]
    Print resolved environment variables.
`);
			if (command && command !== "help" && command !== "--help") {
				console.error(`Unknown command: ${command}`);
				process.exit(1);
			}
	}
}

main().catch((err) => {
	console.error(err.message ?? err);
	process.exit(1);
});
