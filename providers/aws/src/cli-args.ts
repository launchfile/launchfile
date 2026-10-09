/**
 * Argument rules for `launchfile-aws`, kept apart from cli.ts because main()
 * runs at module load and the rules must be testable without spawning it.
 *
 * One verb, four flags. Anything else is refused before dispatch, never
 * dropped ([D-67], #528): a typo'd `--regoin` that fell through to the
 * default region would put a wrong-region `main.tf` on disk with nothing
 * to say so, and the operator's next step is `terraform apply`.
 */

import { stripControlInline } from "@launchfile/sdk";

/** Flags that take a value, in the `--flag <value>` form only. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
	"out",
	"region",
	"rekey",
]);

/** Every long flag this CLI reads. A `--` token whose name is not here is refused. */
export const KNOWN_FLAGS: readonly string[] = [...VALUE_FLAGS, "help"];

export interface TranslateArgs {
	file: string;
	out: string | undefined;
	region: string | undefined;
	rekey: string[];
}

export type ParsedArgs =
	/** Bare invocation or `--help`: print usage, exit 0. */
	| { kind: "help" }
	/** Refused before dispatch: `message` goes to stderr, exit 1. */
	| { kind: "refuse"; message: string }
	| { kind: "translate"; args: TranslateArgs };

function refuse(message: string): ParsedArgs {
	return { kind: "refuse", message };
}

function knownFlagList(): string {
	return KNOWN_FLAGS.map((f) => `--${f}`).join(", ");
}

/** What one pass over the flag positions of argv found. */
interface FlagScan {
	/** The first refusal met in argv order, or undefined when there is none. */
	refusal: ParsedArgs | undefined;
	/** `--help` stands in a flag position — not in a value slot. */
	help: boolean;
}

/**
 * Walks argv reading only flag positions. The token after a `VALUE_FLAGS`
 * flag written as `--flag value` is that flag's value and is not judged
 * ([D-67] rule 3): `--out --typo` is refused by `--out`'s own missing-value
 * check, not as an unknown flag, and `--out --help` does not print usage.
 * A `--` token whose name is not in `KNOWN_FLAGS`, and a bare `--` (this CLI
 * has no end-of-options marker), are refused.
 */
function scanFlags(argv: readonly string[]): FlagScan {
	let help = false;
	const queue = [...argv];
	for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
		if (!arg.startsWith("--")) continue;
		if (arg === "--") {
			return {
				refusal: refuse(
					"`--` on its own is not read: there is no end-of-options marker.\n" +
						`Known flags: ${knownFlagList()}`,
				),
				help,
			};
		}
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		if (VALUE_FLAGS.has(name)) {
			if (eq === -1) queue.shift();
			continue;
		}
		if (name === "help") {
			// `--help=<value>` is refused by the value-form check in parseArgs.
			if (eq === -1) help = true;
			continue;
		}
		return {
			refusal: refuse(
				`no such flag --${stripControlInline(name)}\n` +
					`Known flags: ${knownFlagList()}`,
			),
			help,
		};
	}
	return { refusal: undefined, help };
}

/**
 * Reads `process.argv.slice(2)`. Refusals, in the order they are checked:
 * an unknown `--` flag (named, with the known ones listed) or a bare `--`,
 * a `--` token where the command belongs, a command other than `translate`,
 * a value flag in the `--flag=value` form or with no value, a missing
 * Launchfile path. `--help` prints usage only when it stands as a flag, not
 * as the value slot of `--out`, `--region` or `--rekey`. Every
 * operator-supplied token that is echoed goes through `stripControlInline`
 * first.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	if (argv.length === 0) return { kind: "help" };

	const scan = scanFlags(argv);
	if (scan.refusal !== undefined) return scan.refusal;
	if (scan.help) return { kind: "help" };

	const [command = "", ...rest] = argv;
	if (command.startsWith("--")) {
		return refuse(
			"the command comes before its flags: `launchfile-aws translate <Launchfile> [flags]`",
		);
	}
	if (command !== "translate") {
		return refuse(`Unknown command: ${stripControlInline(command)}`);
	}

	const single = new Map<string, string>();
	const rekey: string[] = [];
	const positionals: string[] = [];
	const queue = [...rest];
	for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		if (!VALUE_FLAGS.has(name)) {
			// Only `--help=<value>` reaches here; the bare form returned above.
			return refuse(`--${name} takes no value, e.g. --${name}`);
		}
		if (eq !== -1) {
			return refuse(
				`${stripControlInline(arg)}: write it as \`--${name} <value>\` — the \`=\` form is not read.`,
			);
		}
		const value = queue.shift();
		if (value === undefined || value.startsWith("--")) {
			return refuse(`--${name} needs a value: \`--${name} <value>\`.`);
		}
		if (name === "rekey") {
			rekey.push(value);
		} else if (single.has(name)) {
			return refuse(`--${name} is given twice; it takes one value.`);
		} else {
			single.set(name, value);
		}
	}

	const [file, ...extra] = positionals;
	if (file === undefined) {
		return refuse(
			"translate needs a Launchfile: `launchfile-aws translate <Launchfile>`.",
		);
	}
	if (extra.length > 0) {
		return refuse(
			`translate takes one Launchfile; unexpected argument: ${stripControlInline(extra.join(" "))}`,
		);
	}
	return {
		kind: "translate",
		args: {
			file,
			out: single.get("out"),
			region: single.get("region"),
			rekey,
		},
	};
}
