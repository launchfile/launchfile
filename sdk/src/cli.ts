#!/usr/bin/env node
/**
 * CLI for the Launchfile SDK.
 *
 * Usage:
 *   launchfile validate [path] [--json] [--quiet]
 *   launchfile inspect [path]
 *   launchfile schema [--schema-path <path>]
 *   launchfile --help
 *   launchfile --version
 */

import { resolve } from "node:path";
import { cmdValidate, cmdInspect, cmdSchema } from "./commands.js";

const VERSION = "0.1.2";

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("-"));
const positionalArgs = args.filter((a) => !a.startsWith("-"));

function hasFlag(flag: string): boolean {
	return args.includes(`--${flag}`);
}

function getFlagValue(flag: string): string | undefined {
	const idx = args.indexOf(`--${flag}`);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

const noColor =
	hasFlag("no-color") || process.env.NO_COLOR !== undefined || !process.stderr.isTTY;

const useColor = !noColor;
const bold = (s: string): string => (useColor ? `\x1b[1m${s}\x1b[22m` : s);
const cyan = (s: string): string => (useColor ? `\x1b[36m${s}\x1b[39m` : s);
const red = (s: string): string => (useColor ? `\x1b[31m${s}\x1b[39m` : s);

const HELP = `${bold("launchfile")} — Launchfile SDK CLI

${bold("Usage:")}
  launchfile validate [path]          Validate a Launchfile
  launchfile inspect [path]           Print normalized JSON
  launchfile schema                   Dump JSON Schema to stdout

${bold("Options:")}
  --json          Output structured JSON (validate)
  --quiet         No output, just exit code (validate)
  --schema-path   Path to JSON Schema file (schema)
  --no-color      Disable colored output
  --version       Show version
  --help          Show this help

${bold("Examples:")}
  launchfile validate
  launchfile validate ./Launchfile --json
  launchfile inspect ./apps/web/Launchfile
  launchfile schema > launchfile.schema.json
`;

function resolvePath(): string {
	const pathArg = positionalArgs[1];
	return resolve(pathArg ?? "./Launchfile");
}

function main(): void {
	if (hasFlag("version")) {
		console.log(`launchfile ${VERSION}`);
		return;
	}

	if (hasFlag("help") || command === "help" || !command) {
		console.log(HELP);
		if (!command && !hasFlag("help")) {
			process.exit(1);
		}
		return;
	}

	switch (command) {
		case "validate":
			cmdValidate(resolvePath(), {
				json: hasFlag("json"),
				quiet: hasFlag("quiet"),
				noColor,
			});
			break;
		case "inspect":
			cmdInspect(resolvePath(), { noColor });
			break;
		case "schema":
			cmdSchema({ schemaPath: getFlagValue("schema-path"), noColor });
			break;
		default:
			console.error(`${red("error:")} Unknown command: ${command}`);
			console.error(`Run ${cyan("launchfile --help")} for usage.`);
			process.exit(1);
	}
}

main();
