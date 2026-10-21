/**
 * Argument parsing for this provider's own CLI entry point.
 *
 * Split from `cli.ts` so the rules are testable: importing `cli.ts` runs
 * `main()`, and its helpers read a module-level `args`. This package has no
 * dependency edge to `packages/launchfile`, so the unified CLI's parser cannot
 * be imported — these rules are deliberately duplicated and must stay in step
 * with `packages/launchfile/src/cli-args.ts`, or one Launchfile yields two
 * running topologies depending on which entry point ran it (P-5, D-41).
 */

/**
 * The D-41 component selector, or undefined when no name is given — an absent
 * flag and an empty value both mean every component. The comma-separated and
 * repeatable forms compose; blanks and duplicates are dropped.
 */
export function parseComponentsFlag(
	args: readonly string[],
): string[] | undefined {
	const names: string[] = [];
	const inlinePrefix = "--components=";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		let raw: string | undefined;
		if (arg === "--components") raw = args[i + 1];
		else if (arg?.startsWith(inlinePrefix))
			raw = arg.slice(inlinePrefix.length);
		if (raw === undefined) continue;
		for (const part of raw.split(",")) {
			const name = part.trim();
			if (name.length > 0 && !names.includes(name)) names.push(name);
		}
	}
	return names.length > 0 ? names : undefined;
}

/**
 * The selector spellings a verb refuses, in tie-break order: the plural is
 * listed first, so when both appear the message names `--components`
 * whatever order they were typed in — the same rule as `SELECTOR_OWNERS` in
 * `packages/launchfile/src/cli-args.ts`.
 */
const SELECTOR_SPELLINGS = ["--components", "--component"] as const;

const SELECTOR_MEANING = {
	"--components": "selects which components `up` starts",
	"--component":
		"is not a `launch` flag (`up` selects components with `--components`)",
} as const satisfies Record<(typeof SELECTOR_SPELLINGS)[number], string>;

/**
 * The refusal a verb owes when a selector spelling appears on it but nothing
 * reads the value. `down` and `status` act on the whole deployment and have no
 * set to narrow, so accepting the flag and ignoring it would stop or report
 * every component while the operator named one. The singular is refused too:
 * the unified CLI refuses it, and this entry point must agree (P-5).
 */
export function selectorRefusal(
	args: readonly string[],
	verb: string,
	action: string,
): readonly [string, string] | undefined {
	const spelled = SELECTOR_SPELLINGS.find((flag) =>
		args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)),
	);
	if (spelled === undefined) return undefined;
	return [
		`${spelled} ${SELECTOR_MEANING[spelled]}; \`${verb}\` ${action}.`,
		`Run \`${verb}\` with no selector.`,
	] as const;
}

/**
 * The refusal `up` owes for the singular `--component`. `up` reads only
 * `--components`, so accepting the singular would start every component while
 * the operator named one (D-41). The unified CLI refuses it on `up` (D-67);
 * this entry point must agree (P-5). The text names `launch` verbs only: this
 * CLI has no `bootstrap`, the verb the singular limits in the unified CLI.
 */
export function upComponentRefusal(
	args: readonly string[],
): readonly [string, string] | undefined {
	const spelled = args.some(
		(arg) => arg === "--component" || arg.startsWith("--component="),
	);
	if (!spelled) return undefined;
	return [
		"--component is not a `launch` flag; `up` selects components with `--components <name>[,<name>…]`.",
		"Run `launch up --components <name>` instead.",
	] as const;
}
