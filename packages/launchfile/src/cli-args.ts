/**
 * Argument helpers for the unified CLI.
 *
 * A tiny declared-flag table rather than a full parser (#248): `getPositional`
 * must know which flags consume the next token, or a flag's value is read as a
 * positional — `launchfile up --name foo` would target `foo` instead of the
 * cwd. Exported separately from cli.ts so the parsing rules are testable
 * without spawning the CLI.
 */

/** Flags that take a value in the `--flag value` form. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
	"name",
	"component",
	"components",
	"schema-path",
	"storage",
]);

export function hasFlag(args: readonly string[], flag: string): boolean {
	return args.includes(`--${flag}`) || args.includes(`-${flag[0]}`);
}

/** True when `--flag` or `--flag=…` appears — exact long form only, no short alias. */
export function flagPresent(args: readonly string[], flag: string): boolean {
	return args.some((arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`));
}

/** The value of `--flag <value>` or `--flag=<value>`, whichever appears first. */
export function getFlagValue(args: readonly string[], flag: string): string | undefined {
	const inlinePrefix = `--${flag}=`;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === `--${flag}`) return args[i + 1];
		if (arg.startsWith(inlinePrefix)) return arg.slice(inlinePrefix.length);
	}
	return undefined;
}

/**
 * Every value of a repeatable flag, in order — `--flag <value>` and
 * `--flag=<value>` forms both count. `--storage` (D-50) repeats once per
 * operator-supplied volume.
 */
export function getFlagValues(args: readonly string[], flag: string): string[] {
	const inlinePrefix = `--${flag}=`;
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === `--${flag}`) {
			if (args[i + 1] !== undefined) values.push(args[i + 1]!);
		} else if (arg.startsWith(inlinePrefix)) {
			values.push(arg.slice(inlinePrefix.length));
		}
	}
	return values;
}

/**
 * Parse repeated `--storage <key>=<path>` values (D-50) into a key-to-path
 * map. The key half — a volume name, or `component.volume` — passes through
 * as typed: the first-dot split needs the parsed Launchfile's component
 * names, so it happens in the provider. A malformed pair or a duplicate key
 * is rejected with the offending value, never guessed at.
 */
export function parseStoragePairs(values: readonly string[]): Record<string, string> {
	const pairs: Record<string, string> = {};
	for (const value of values) {
		const eq = value.indexOf("=");
		const key = eq === -1 ? "" : value.slice(0, eq);
		const path = eq === -1 ? "" : value.slice(eq + 1);
		if (!key || !path) {
			throw new Error(
				`Invalid --storage value "${value}". Expected --storage <volume>=<host-path>, ` +
					"or --storage <component>.<volume>=<host-path> where the volume name is ambiguous.",
			);
		}
		if (pairs[key] !== undefined) {
			throw new Error(
				`Duplicate --storage key "${key}". Each volume takes one path; repeat the flag for different volumes.`,
			);
		}
		pairs[key] = path;
	}
	return pairs;
}

/**
 * Parse `--components <name>[,<name>…]` values (D-41) into component names.
 * The repeatable and comma-separated forms compose, so `--components a,b
 * --components c` selects three; blanks and duplicates are dropped.
 *
 * An empty result means "all components" — D-41's "selecting nothing acts on
 * all components" — so `--components ""` starts the same set as omitting the
 * flag, rather than a third, empty one.
 */
export function parseComponentNames(values: readonly string[]): string[] {
	const names: string[] = [];
	for (const value of values) {
		for (const part of value.split(",")) {
			const name = part.trim();
			if (name.length > 0 && !names.includes(name)) names.push(name);
		}
	}
	return names;
}

/** What each selector spelling means, and to which verb it belongs. */
const SELECTOR_OWNERS: ReadonlyArray<readonly [flag: string, meaning: string]> = [
	["components", "selects which components `up`/`dev` start"],
	["component", "limits `bootstrap` to a single component"],
];

/**
 * The refusal a verb owes when a selector spelling appears on it but nothing
 * reads the value, or undefined when neither spelling is present.
 *
 * `VALUE_FLAGS` is global, so `--components web` parses on EVERY verb and
 * `getPositional` skips its value. A verb that never reads it would therefore
 * drop the name and act on every component — `down --destroy --components web`
 * would remove the whole app while the operator named one. Silent acceptance
 * is not an option (D-41, #232).
 */
export function selectorRefusal(
	args: readonly string[],
	verb: string,
	action: string,
): readonly [string, string] | undefined {
	const owner = SELECTOR_OWNERS.find(([flag]) => flagPresent(args, flag));
	if (owner === undefined) return undefined;
	const [flag, meaning] = owner;
	return [
		`--${flag} ${meaning}; \`${verb}\` ${action}.`,
		`Run \`${verb}\` with no selector.`,
	] as const;
}

/**
 * The Nth positional argument: skips flags AND the value token of any
 * `VALUE_FLAGS` flag written in the `--flag value` form (`--flag=value` is a
 * single token and needs no skip).
 */
export function getPositional(args: readonly string[], index: number): string | undefined {
	let pos = 0;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.startsWith("-")) {
			if (arg.startsWith("--") && VALUE_FLAGS.has(arg.slice(2))) i++;
			continue;
		}
		if (pos === index) return arg;
		pos++;
	}
	return undefined;
}
