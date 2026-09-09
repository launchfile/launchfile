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

const args = process.argv.slice(2);
const command = args[0];

function hasFlag(flag: string): boolean {
	return args.includes(`--${flag}`);
}

function getArg(index: number): string | undefined {
	return args[index];
}

/**
 * The D-41 component selector, or undefined when no name is given — an absent
 * flag and an empty value both mean every component. Comma-separated and
 * repeatable forms compose. The unified `launchfile` CLI accepts the same
 * spelling: both entry points must reach `selectionClosure` with the same
 * names, or one Launchfile yields two running topologies (P-5).
 */
function componentsFlag(): string[] | undefined {
	const names: string[] = [];
	const inlinePrefix = "--components=";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		let raw: string | undefined;
		if (arg === "--components") raw = args[i + 1];
		else if (arg.startsWith(inlinePrefix)) raw = arg.slice(inlinePrefix.length);
		if (raw === undefined) continue;
		for (const part of raw.split(",")) {
			const name = part.trim();
			if (name.length > 0 && !names.includes(name)) names.push(name);
		}
	}
	return names.length > 0 ? names : undefined;
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
