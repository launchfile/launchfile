#!/usr/bin/env node
/**
 * Unified Launchfile CLI.
 *
 * Usage:
 *   launchfile up [slug|path]          Start an app
 *   launchfile down [id|slug|name]     Stop a deployment
 *   launchfile status [id|slug|name]   Show deployment status
 *   launchfile logs [id|slug|name]     View logs
 *   launchfile list                    List all deployments
 *   launchfile validate [path]         Validate a Launchfile
 *   launchfile inspect [path]          Print normalized JSON
 *   launchfile schema                  Dump JSON Schema
 */

import { resolve, dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleUp } from "./commands/up.js";
import { handleDown } from "./commands/down.js";
import { handleStatus } from "./commands/status.js";
import { handleLogs } from "./commands/logs.js";
import { handleList } from "./commands/list.js";
import { handleBootstrap } from "./commands/bootstrap.js";
import { cmdValidate, cmdInspect, cmdSchema } from "@launchfile/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: VERSION } = JSON.parse(
	readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);

const args = process.argv.slice(2);

function hasFlag(flag: string): boolean {
	return args.includes(`--${flag}`) || args.includes(`-${flag[0]}`);
}

function getFlagValue(flag: string): string | undefined {
	const idx = args.indexOf(`--${flag}`);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

/** Get the Nth positional argument (skipping flags) */
function getPositional(index: number): string | undefined {
	let pos = 0;
	for (const arg of args) {
		if (arg.startsWith("-")) continue;
		if (pos === index) return arg;
		pos++;
	}
	return undefined;
}

const command = getPositional(0);
const target = getPositional(1);

const noColor =
	hasFlag("no-color") || process.env.NO_COLOR !== undefined || !process.stderr.isTTY;

const HELP = `launchfile — describe your app, deploy it anywhere

Usage:
  launchfile up [slug|path]          Start an app (Docker or native)
  launchfile down [id|slug]          Stop a deployment
  launchfile status [id|slug]        Show deployment status
  launchfile logs [id|slug]          View logs
  launchfile bootstrap [id|slug]     Run post-start setup (commands.bootstrap)
  launchfile list                    List all deployments
  launchfile validate [path]         Validate a Launchfile
  launchfile inspect [path]          Print normalized JSON
  launchfile schema                  Dump JSON Schema to stdout

Provider flags:
  --docker         Force Docker provider
  --native         Force macOS native provider (Homebrew)

Options:
  --dry-run        Preview without starting anything
  --destroy        Remove all containers and data (with down)
  --follow, -f     Stream logs continuously
  --name <name>    Name this deployment
  --component <n>  Limit bootstrap to a single component
  --help           Show this help
  --version        Show version

Examples:
  launchfile up ghost                Run Ghost from the catalog
  launchfile up                      Run the app in the current directory
  launchfile down --destroy          Stop and remove everything
  launchfile list                    Show all deployments
`;

async function main(): Promise<void> {
	if (hasFlag("version")) {
		console.log(`launchfile ${VERSION}`);
		return;
	}

	if (hasFlag("help") || command === "help" || !command) {
		console.log(HELP);
		if (!command && !hasFlag("help")) process.exit(1);
		return;
	}

	switch (command) {
		case "up":
			await handleUp(target, {
				docker: hasFlag("docker"),
				native: hasFlag("native"),
				detach: hasFlag("detach"),
				dryRun: hasFlag("dry-run"),
				name: getFlagValue("name"),
			});
			break;

		case "down":
			await handleDown(target, {
				destroy: hasFlag("destroy"),
			});
			break;

		case "status":
			await handleStatus(target);
			break;

		case "logs":
			await handleLogs(target, {
				follow: hasFlag("follow") || args.includes("-f"),
			});
			break;

		case "list":
		case "ls":
			await handleList();
			break;

		case "bootstrap":
			await handleBootstrap(target, {
				component: getFlagValue("component"),
			});
			break;

		case "validate": {
			const path = resolve(target ?? "./Launchfile");
			cmdValidate(path, { json: hasFlag("json"), quiet: hasFlag("quiet"), noColor });
			break;
		}

		case "inspect": {
			const path = resolve(target ?? "./Launchfile");
			cmdInspect(path, { noColor });
			break;
		}

		case "schema":
			cmdSchema({ schemaPath: getFlagValue("schema-path"), noColor });
			break;

		default:
			console.error(`Unknown command: ${command}`);
			console.error("Run `launchfile --help` for usage.");
			process.exit(1);
	}
}

main().catch((err: Error) => {
	console.error(`\nError: ${err.message}`);
	process.exit(1);
});
