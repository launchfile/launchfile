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
	"schema-path",
]);

export function hasFlag(args: readonly string[], flag: string): boolean {
	return args.includes(`--${flag}`) || args.includes(`-${flag[0]}`);
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
