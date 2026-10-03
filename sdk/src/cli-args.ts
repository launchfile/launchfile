/**
 * Argument helpers for the SDK CLI.
 *
 * Two declared-flag tables are the single source of truth for what `cli.ts`
 * accepts: a long flag in neither table is refused before dispatch (#636).
 * Exported separately from cli.ts so the parsing rules are testable without
 * spawning the CLI.
 */

export const VALUE_FLAGS = ["schema-path"] as const;

export const BOOLEAN_FLAGS = [
	"json",
	"quiet",
	"detached",
	"no-color",
	"version",
	"help",
] as const;

export type ValueFlag = (typeof VALUE_FLAGS)[number];
export type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];
export type KnownFlag = ValueFlag | BooleanFlag;

const ALL_FLAGS: readonly KnownFlag[] = [...VALUE_FLAGS, ...BOOLEAN_FLAGS];

function isValueFlag(name: string): boolean {
	return (VALUE_FLAGS as readonly string[]).includes(name);
}

function isKnownFlag(name: string): boolean {
	return (ALL_FLAGS as readonly string[]).includes(name);
}

/**
 * Every long flag in argv that neither table declares, as bare names in argv
 * order. `--name` and `--name=value` both count. The token after a value flag
 * is its value and is skipped, so it is never judged as a flag here. Single-dash
 * tokens are not judged (#529).
 */
export function unknownFlags(args: readonly string[]): string[] {
	const unknown: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!arg.startsWith("--")) continue;
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		if (isValueFlag(name)) {
			if (eq === -1) i++;
			continue;
		}
		if (isKnownFlag(name)) continue;
		unknown.push(name);
	}
	return unknown;
}

/**
 * The one declared flag an unknown name most plausibly meant, or undefined
 * when none fits or several fit equally. A candidate fits when one name is a
 * prefix of the other or the edit distance is at most 2. Ties yield nothing.
 */
export function suggestFlag(name: string): KnownFlag | undefined {
	let best: KnownFlag | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	let tied = false;
	for (const candidate of ALL_FLAGS) {
		const distance = editDistance(name, candidate);
		const prefix =
			name.length > 0 && (candidate.startsWith(name) || name.startsWith(candidate));
		if (!prefix && distance > 2) continue;
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
			tied = false;
		} else if (distance === bestDistance) {
			tied = true;
		}
	}
	return tied ? undefined : best;
}

/** Levenshtein distance — insertions, deletions and substitutions each cost 1. */
function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
			current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
		}
		previous = current;
	}
	return previous[b.length]!;
}

/** True when `--flag` or `--flag=…` appears. */
export function flagPresent(args: readonly string[], flag: KnownFlag): boolean {
	return args.some((arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`));
}

/**
 * The value of `--flag <value>` or `--flag=<value>`, whichever appears first.
 * A `--flag` with no following token returns undefined; the token after it is
 * returned as-is, so the caller decides whether a `--` token is a value.
 */
export function getFlagValue(args: readonly string[], flag: ValueFlag): string | undefined {
	const inlinePrefix = `--${flag}=`;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === `--${flag}`) return args[i + 1];
		if (arg.startsWith(inlinePrefix)) return arg.slice(inlinePrefix.length);
	}
	return undefined;
}

/**
 * The Nth positional argument: skips every `-` token and the value token of a
 * value flag written in the `--flag value` form.
 */
export function getPositional(args: readonly string[], index: number): string | undefined {
	let pos = 0;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.startsWith("-")) {
			if (arg.startsWith("--") && isValueFlag(arg.slice(2))) i++;
			continue;
		}
		if (pos === index) return arg;
		pos++;
	}
	return undefined;
}
