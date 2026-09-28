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
 * The refusal a verb owes when the selector appears on it but nothing reads
 * the value. `down` and `status` act on the whole deployment and have no set
 * to narrow, so accepting the flag and ignoring it would stop or report every
 * component while the operator named one.
 */
export function selectorRefusal(
	args: readonly string[],
	verb: string,
	action: string,
): readonly [string, string] | undefined {
	const present = args.some(
		(arg) => arg === "--components" || arg.startsWith("--components="),
	);
	if (!present) return undefined;
	return [
		`--components selects which components \`up\` starts; \`${verb}\` ${action}.`,
		`Run \`${verb}\` with no selector.`,
	] as const;
}
