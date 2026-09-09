#!/usr/bin/env node
/**
 * Unified Launchfile CLI.
 *
 * Usage:
 *   launchfile up [slug|path]          Start an app
 *   launchfile down [id|slug|name]     Stop a deployment
 *   launchfile status [id|slug|name]   Show deployment status
 *   launchfile logs [id|slug|name]     View logs
 *   launchfile diagnose [id|slug]      Explain the last failed launch
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
import { handleDiagnose } from "./commands/diagnose.js";
import { cmdValidate, cmdInspect, cmdSchema } from "@launchfile/sdk";
import {
	hasFlag as argsHasFlag,
	getFlagValue as argsGetFlagValue,
	getFlagValues as argsGetFlagValues,
	getPositional as argsGetPositional,
	flagPresent as argsFlagPresent,
	parseComponentNames,
	parseStoragePairs,
	selectorRefusal,
} from "./cli-args.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: VERSION } = JSON.parse(
	readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);

const args = process.argv.slice(2);

const hasFlag = (flag: string): boolean => argsHasFlag(args, flag);
const getFlagValue = (flag: string): string | undefined => argsGetFlagValue(args, flag);
const getPositional = (index: number): string | undefined => argsGetPositional(args, index);

/**
 * The instance label, or undefined when --name was not given. A `--name` with
 * no value (nothing follows, `--name=`, or another flag follows) is an error —
 * silently launching the unnamed instance would target different state than
 * the user asked for.
 */
function getNameFlag(): string | undefined {
	if (!argsFlagPresent(args, "name")) return undefined;
	const value = getFlagValue("name");
	if (!value || value.startsWith("-")) {
		console.error("--name requires a value, e.g. --name test-a");
		process.exit(1);
	}
	return value;
}

/** The D-50 `--storage` volume-to-path map, or undefined when the flag is absent. */
const storageFlag = (): Record<string, string> | undefined => {
	const values = argsGetFlagValues(args, "storage");
	return values.length > 0 ? parseStoragePairs(values) : undefined;
};

/**
 * The D-41 `--components` selector, or undefined when no name is given —
 * an absent flag and an empty value both mean every component.
 */
const componentsFlag = (): string[] | undefined => {
	const names = parseComponentNames(argsGetFlagValues(args, "components"));
	return names.length > 0 ? names : undefined;
};

/**
 * A flag's value as typed when the long form is present (empty string when it
 * carries none), or undefined when it is absent. Presence is what the two
 * wrong-command refusals key on: `--component` on `up`/`dev` and `--components`
 * on `bootstrap` both parse, so each command must see them to reject them.
 */
const flagAsTyped = (flag: string): string | undefined =>
	argsFlagPresent(args, flag) ? (getFlagValue(flag) ?? "") : undefined;

/**
 * Exit 1 when a selector spelling reaches a verb that acts on the whole
 * deployment. The declared-flag table is global, so the flag parses here and
 * its value would otherwise be dropped without a word.
 */
const refuseSelector = (verb: string, action: string): void => {
	const lines = selectorRefusal(args, verb, action);
	if (lines === undefined) return;
	for (const line of lines) console.error(line);
	process.exit(1);
};

const command = getPositional(0);
const target = getPositional(1);

const noColor =
	hasFlag("no-color") || process.env.NO_COLOR !== undefined || !process.stderr.isTTY;

const HELP = `launchfile — describe your app, deploy it anywhere

Usage:
  launchfile up [slug|path]          Start an app as a built artifact (Docker)
  launchfile dev [path]              Run an app from source (install/dev, native)
  launchfile down [id|slug]          Stop a deployment
  launchfile status [id|slug]        Show deployment status
  launchfile logs [id|slug]          View logs
  launchfile diagnose [id|slug]      Explain why the last launch failed
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
  --name <label>   Launch a separate named instance of the app — its own
                    state, volumes, network, and ports (Docker provider)
  --storage <volume>=<path>
                   Host path for a volume marked \`content: operator\` — you
                    supply its content; the provider binds it there instead of
                    creating an empty volume. Repeat per volume; spell the key
                    <component>.<volume> where the volume name is ambiguous
  --components <a,b>
                   Start only these components plus their downward dependency
                    closure — their depends_on targets and every closure
                    member's required services (D-41). Comma-separated and
                    repeatable; omit it to start every component (with up, dev)
  --component <n>  Limit bootstrap to a single component
  --detached       (validate) Evaluate as fetched standalone, not read from the
                    app's own checkout — enables the D-43 reduced-portability check
  --json           Machine-readable output (with diagnose, validate)
  --help           Show this help
  --version        Show version

Environment:
  LAUNCHFILE_NO_PORTABILITY_WARNINGS   Set (to any value except "0"/"false") to silence validate's D-40/D-43 reduced-portability warnings

Examples:
  launchfile up ghost                Run Ghost from the catalog
  launchfile up                      Run the app in the current directory
  launchfile up --components api     Run api and what it depends on, nothing else
  launchfile diagnose                Explain the last failed launch
  launchfile diagnose --json         The same record, for a script
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
				name: getNameFlag(),
				components: componentsFlag(),
				component: flagAsTyped("component"),
				storage: storageFlag(),
			});
			break;

		case "dev":
			// Source mode (D-38): run from source via install/dev. Forces the
			// native provider, which resolves `install ?? build` (prepare) and
			// `dev ?? start` (run) in the component's `source` directory.
			await handleUp(target, {
				native: true,
				detach: hasFlag("detach"),
				dryRun: hasFlag("dry-run"),
				name: getNameFlag(),
				components: componentsFlag(),
				component: flagAsTyped("component"),
				storage: storageFlag(),
			});
			break;

		case "down":
			refuseSelector("down", "stops the whole deployment");
			await handleDown(target, {
				destroy: hasFlag("destroy"),
			});
			break;

		case "status":
			refuseSelector("status", "reports the whole deployment");
			await handleStatus(target);
			break;

		case "logs":
			await handleLogs(target, {
				follow: hasFlag("follow") || args.includes("-f"),
			});
			break;

		case "diagnose": {
			const code = await handleDiagnose(target, { json: hasFlag("json") });
			if (code !== 0) process.exit(code);
			break;
		}

		case "list":
		case "ls":
			await handleList();
			break;

		case "bootstrap":
			await handleBootstrap(target, {
				component: getFlagValue("component"),
				components: flagAsTyped("components"),
			});
			break;

		case "validate": {
			const path = resolve(target ?? "./Launchfile");
			cmdValidate(path, {
				json: hasFlag("json"),
				quiet: hasFlag("quiet"),
				detached: hasFlag("detached"),
				noColor,
			});
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
