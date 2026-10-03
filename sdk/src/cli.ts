#!/usr/bin/env node
/**
 * CLI for the Launchfile SDK.
 *
 * Usage:
 *   launchfile validate [path] [--json] [--quiet] [--detached]
 *   launchfile inspect [path]
 *   launchfile schema [--schema-path <path>]
 *   launchfile --help
 *   launchfile --version
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cmdValidate, cmdInspect, cmdSchema } from "./commands.js";
import {
	flagPresent,
	getFlagValue,
	getPositional,
	suggestFlag,
	unknownFlags,
	valuedBooleanFlag,
	type BooleanFlag,
} from "./cli-args.js";
import { stripControlInline } from "./errors.js";

const args = process.argv.slice(2);
const command = getPositional(args, 0);

function hasFlag(flag: BooleanFlag): boolean {
	return args.includes(`--${flag}`);
}

/** The package version, read from the `package.json` one directory above this file. */
function readVersion(): string {
	const pkgUrl = new URL("../package.json", import.meta.url);
	const pkg = JSON.parse(readFileSync(pkgUrl, "utf-8")) as { version: string };
	return pkg.version;
}

/**
 * Refuse any long flag outside the declared tables, and a `--schema-path`
 * with no value, before any verb or `--version`/`--help` runs. Output is
 * uncolored: this runs before the color setting is decided.
 */
function refuseBadFlags(): void {
	const valued = valuedBooleanFlag(args);
	if (valued !== undefined) {
		process.stderr.write(
			`error: --${valued} takes no value: write --${valued}, not --${valued}=<value>. Run launchfile --help for usage.\n`,
		);
		process.exit(1);
	}
	const [unknown] = unknownFlags(args);
	if (unknown !== undefined) {
		const suggestion = suggestFlag(unknown);
		const hint = suggestion === undefined ? "" : ` Did you mean --${suggestion}?`;
		process.stderr.write(
			`error: Unknown flag: --${stripControlInline(unknown)}.${hint} Run launchfile --help for usage.\n`,
		);
		process.exit(1);
	}
	if (flagPresent(args, "schema-path")) {
		const value = getFlagValue(args, "schema-path");
		if (value === undefined || value === "" || value.startsWith("--")) {
			process.stderr.write(
				"error: --schema-path needs a value: --schema-path <path>. Run launchfile --help for usage.\n",
			);
			process.exit(1);
		}
	}
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
  --detached      Evaluate as fetched standalone, not read from the app's own
                   checkout — enables the D-43 reduced-portability check (validate)
  --schema-path   Path to JSON Schema file (schema)
  --no-color      Disable colored output
  --version       Show version
  --help          Show this help

${bold("Environment:")}
  LAUNCHFILE_NO_PORTABILITY_WARNINGS   Set to silence the D-40/D-43 reduced-portability warnings

${bold("Examples:")}
  launchfile validate
  launchfile validate ./Launchfile --json
  launchfile validate ./Launchfile --detached
  launchfile inspect ./apps/web/Launchfile
  launchfile schema > launchfile.schema.json
`;

function resolvePath(): string {
	const pathArg = getPositional(args, 1);
	return resolve(pathArg ?? "./Launchfile");
}

function main(): void {
	refuseBadFlags();

	if (hasFlag("version")) {
		console.log(`launchfile ${readVersion()}`);
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
				detached: hasFlag("detached"),
				noColor,
			});
			break;
		case "inspect":
			cmdInspect(resolvePath(), { noColor });
			break;
		case "schema":
			cmdSchema({ schemaPath: getFlagValue(args, "schema-path"), noColor });
			break;
		default:
			console.error(`${red("error:")} Unknown command: ${command}`);
			console.error(`Run ${cyan("launchfile --help")} for usage.`);
			process.exit(1);
	}
}

main();
