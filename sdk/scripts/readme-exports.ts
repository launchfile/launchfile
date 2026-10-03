/**
 * Pure parsing helpers for check-readme-exports.ts. Each function takes
 * source text, never a path, so tests can feed it fixtures.
 *
 * Lives under scripts/, not src/, so it stays out of the published dist.
 *
 * Parses index.ts by regex rather than the TypeScript compiler API: sdk
 * pins `typescript@7`, the native ("Corsa") compiler, which does not ship
 * the classic `ts.createProgram`/`SymbolFlags` JS API this would otherwise
 * use. index.ts is barrel-only and biome-formatted, so a small regex over
 * its `export { … } from "…"` / `export type { … } from "…"` statements is
 * enough to classify every entry as value or type-only.
 */

export interface ExportStatement {
	/** Raw specifier list, e.g. ["type Deprecation", "lintDeprecations"]. */
	specifiers: string[];
	/** True for `export type { … }` and `export type * from …` statements. */
	typeOnly: boolean;
}

export function parseExportStatements(source: string): ExportStatement[] {
	const statements: ExportStatement[] = [];

	// `export type * from "…";` — wildcard type re-export, no named values.
	const wildcardTypeRe = /export\s+type\s*\*\s*from\s*"[^"]+";/g;
	const withoutWildcards = source.replace(wildcardTypeRe, "");

	// `export type { A, B } from "…";` or `export { A, type B } from "…";`
	const namedExportRe = /export\s+(type\s*)?\{([^}]*)\}\s*from\s*"[^"]+";/gs;
	for (const match of withoutWildcards.matchAll(namedExportRe)) {
		const statementIsTypeOnly = match[1] !== undefined;
		const specifiers = match[2]!
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		statements.push({ specifiers, typeOnly: statementIsTypeOnly });
	}

	// Any other export form — `export * from "…"`, `export const`,
	// `export function`, `export default` — names values this parser cannot
	// see, so the coverage check would pass while documenting nothing. The
	// barrel-only shape of index.ts is what makes the two regexes above
	// sufficient, so enforce it here rather than assuming it.
	const leftover = withoutWildcards
		.replace(namedExportRe, "")
		.match(/^[ \t]*export\b.*$/m);
	if (leftover) {
		throw new Error(
			`src/index.ts has an export form this check cannot parse: ${leftover[0].trim()}\n` +
				`index.ts must stay barrel-only ('export { … } from "…";'), or parseExportStatements must learn the new form.`,
		);
	}

	return statements;
}

/** Resolve one specifier (e.g. "type Foo", "Bar", "Baz as Qux") to its exported name + value/type-ness. */
export function resolveSpecifier(
	spec: string,
	statementIsTypeOnly: boolean,
): { name: string; isValue: boolean } {
	const isTypeSpecifier = statementIsTypeOnly || /^type\s+/.test(spec);
	const withoutTypeKeyword = spec.replace(/^type\s+/, "");
	// `X as Y` re-exports under the local name Y.
	const asMatch = withoutTypeKeyword.match(/^(.+?)\s+as\s+(.+)$/);
	const name = (asMatch ? asMatch[2] : withoutTypeKeyword)!.trim();
	return { name, isValue: !isTypeSpecifier };
}

export function getValueExports(source: string): Set<string> {
	const statements = parseExportStatements(source);

	const values = new Set<string>();
	for (const stmt of statements) {
		for (const spec of stmt.specifiers) {
			const { name, isValue } = resolveSpecifier(spec, stmt.typeOnly);
			if (isValue) values.add(name);
		}
	}
	return values;
}

/** Extract the documented function/export names from README.md's "## API" table. */
export function getReadmeApiTableNames(readme: string): Set<string> {
	const lines = readme.split("\n");

	const headingIdx = lines.findIndex((l) => l.trim() === "## API");
	if (headingIdx === -1) {
		throw new Error(`README has no "## API" heading.`);
	}
	const nextHeadingIdx = lines.findIndex(
		(l, i) => i > headingIdx && /^##\s/.test(l),
	);
	const sectionEnd = nextHeadingIdx === -1 ? lines.length : nextHeadingIdx;
	const section = lines.slice(headingIdx + 1, sectionEnd);

	const names = new Set<string>();
	for (const line of section) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) continue;
		// Skip the header row and the `|---|---|` separator row.
		if (/^\|\s*-+\s*\|/.test(trimmed)) continue;
		if (/^\|\s*Function\s*\|/i.test(trimmed)) continue;
		const cellMatch = trimmed.match(/^\|\s*`([^`]+)`/);
		if (!cellMatch) continue;
		const cell = cellMatch[1]!;
		const name = cell.split("(")[0]!.trim();
		names.add(name);
	}
	return names;
}
