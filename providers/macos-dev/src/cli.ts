#!/usr/bin/env bun
/**
 * CLI entry point for the macOS dev provider.
 *
 * Usage:
 *   launch up [--with-optional] [--no-build] [--dry-run] [--components <a,b>]
 *   launch down [--destroy]
 *   launch status
 *   launch env [component]
 */

import { launchUp, launchDown, launchStatus, launchEnv } from "./provider.js";
import { parseComponentsFlag, selectorRefusal } from "./cli-args.js";

const args = process.argv.slice(2);
const command = args[0];

function hasFlag(flag: string): boolean {
	return args.includes(`--${flag}`);
}

function getArg(index: number): string | undefined {
	return args[index];
}

/** The D-41 component selector for this invocation. */
function componentsFlag(): string[] | undefined {
	return parseComponentsFlag(args);
}

/** Exit 1 when the selector reaches a verb that acts on the whole deployment. */
function refuseSelector(verb: string, action: string): void {
	const lines = selectorRefusal(args, verb, action);
	if (lines === undefined) return;
	for (const line of lines) console.error(line);
	process.exit(1);
}

async function main(): Promise<void> {
	switch (command) {
		case "up":
			await launchUp({
				withOptional: hasFlag("with-optional"),
				noBuild: hasFlag("no-build"),
				dryRun: hasFlag("dry-run"),
				detach: hasFlag("detach"),
				components: componentsFlag(),
			});
			break;

		case "down":
			refuseSelector("down", "stops the whole deployment");
			await launchDown({
				destroy: hasFlag("destroy"),
			});
			break;

		case "status":
			refuseSelector("status", "reports the whole deployment");
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
  launch up [--with-optional] [--no-build] [--dry-run] [--components <a,b>]
    Provision resources, install deps, and start the app.
    --components starts only the named components plus their downward
    dependency closure (D-41); omit it to start every component.

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
