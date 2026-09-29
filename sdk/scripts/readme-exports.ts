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
	/** The module specifier after `from`, e.g. "./captures.js". */
	from: string;
}

export function parseExportStatements(source: string): ExportStatement[] {
	const statements: ExportStatement[] = [];

	// `export type * from "…";` — wildcard type re-export, no named values.
	const wildcardTypeRe = /export\s+type\s*\*\s*from\s*"[^"]+";/g;
	const withoutWildcards = source.replace(wildcardTypeRe, "");

	// `export type { A, B } from "…";` or `export { A, type B } from "…";`
	const namedExportRe = /export\s+(type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)";/gs;
	for (const match of withoutWildcards.matchAll(namedExportRe)) {
		const statementIsTypeOnly = match[1] !== undefined;
		const specifiers = match[2]!
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		statements.push({
			specifiers,
			typeOnly: statementIsTypeOnly,
			from: match[3]!,
		});
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

/**
 * Resolve one specifier (e.g. "type Foo", "Bar", "Baz as Qux") to its
 * exported name, the name it is declared under in the source module, and
 * value/type-ness.
 */
export function resolveSpecifier(
	spec: string,
	statementIsTypeOnly: boolean,
): { name: string; localName: string; isValue: boolean } {
	const isTypeSpecifier = statementIsTypeOnly || /^type\s+/.test(spec);
	const withoutTypeKeyword = spec.replace(/^type\s+/, "");
	// `X as Y` re-exports the source module's X under the name Y.
	const asMatch = withoutTypeKeyword.match(/^(.+?)\s+as\s+(.+)$/);
	const localName = (asMatch ? asMatch[1] : withoutTypeKeyword)!.trim();
	const name = (asMatch ? asMatch[2] : withoutTypeKeyword)!.trim();
	return { name, localName, isValue: !isTypeSpecifier };
}

export interface ValueExportSource {
	/** The name the value is declared under in its source module. */
	localName: string;
	/** The module specifier index.ts re-exports it from, e.g. "./captures.js". */
	from: string;
}

/** Every value export of index.ts, keyed by exported name, with where it comes from. */
export function getValueExportSources(
	source: string,
): Map<string, ValueExportSource> {
	const values = new Map<string, ValueExportSource>();
	for (const stmt of parseExportStatements(source)) {
		for (const spec of stmt.specifiers) {
			const { name, localName, isValue } = resolveSpecifier(
				spec,
				stmt.typeOnly,
			);
			if (isValue) values.set(name, { localName, from: stmt.from });
		}
	}
	return values;
}

export function getValueExports(source: string): Set<string> {
	return new Set(getValueExportSources(source).keys());
}

/**
 * Map an index.ts module specifier to the sdk-relative source file that
 * declares it: "./captures.js" → "src/captures.ts". Throws for anything but
 * a sibling module inside src/, which this check has no way to follow.
 */
export function sourcePathForSpecifier(from: string): string {
	const match = from.match(/^\.\/([\w-]+)\.js$/);
	if (!match) {
		throw new Error(
			`re-exported from "${from}", which is not a "./<module>.js" sibling inside src/ — the arity check cannot follow it`,
		);
	}
	return `src/${match[1]}.ts`;
}

/**
 * Extract README.md's "## API" table rows as documented name → first cell,
 * e.g. "formatCaptures" → "formatCaptures(captures, captureMeta, reveal, options?)".
 */
export function getReadmeApiTableRows(readme: string): Map<string, string> {
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

	const rows = new Map<string, string>();
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
		rows.set(name, cell);
	}
	return rows;
}

/** Extract the documented function/export names from README.md's "## API" table. */
export function getReadmeApiTableNames(readme: string): Set<string> {
	return new Set(getReadmeApiTableRows(readme).keys());
}

export interface Param {
	/** The parameter as written, whitespace collapsed. */
	text: string;
	/** True for `name?` and for a parameter with a default. */
	optional: boolean;
}

const OPENERS: Record<string, string> = {
	"(": ")",
	"[": "]",
	"{": "}",
	"<": ">",
};
const CLOSERS = new Set(Object.values(OPENERS));

/** Index of the last character of the string literal or comment starting at `i`, or -1 if none starts there. */
function skipLiteralOrComment(text: string, i: number): number {
	const ch = text[i];
	if (ch === '"' || ch === "'" || ch === "`") {
		const end = text.indexOf(ch, i + 1);
		if (end === -1) throw new Error("unterminated string literal");
		return end;
	}
	if (ch === "/" && text[i + 1] === "/") {
		const end = text.indexOf("\n", i);
		return end === -1 ? text.length - 1 : end;
	}
	if (ch === "/" && text[i + 1] === "*") {
		const end = text.indexOf("*/", i + 2);
		if (end === -1) throw new Error("unterminated comment");
		return end + 1;
	}
	return -1;
}

/** Remove comments, leaving string literals intact. */
function stripComments(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const end = skipLiteralOrComment(text, i);
		if (end === -1) {
			out += text[i];
			continue;
		}
		if (text[i] !== "/") out += text.slice(i, end + 1);
		i = end;
	}
	return out;
}

/**
 * Walk `text` from `start`, tracking bracket depth and skipping string
 * literals, comments and `=>` (so its ">" is not read as a closer). Calls
 * `onTopLevel(ch, i)` for each other character at depth 0. Returns the index of the closer that takes depth below 0, or
 * `text.length` if none does.
 */
function scanTopLevel(
	text: string,
	start: number,
	onTopLevel: (ch: string, i: number) => void,
): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		const skipTo = skipLiteralOrComment(text, i);
		if (skipTo !== -1) {
			i = skipTo;
			continue;
		}
		if (ch === "=" && text[i + 1] === ">") {
			i++;
			continue;
		}
		if (ch in OPENERS) {
			depth++;
			continue;
		}
		if (CLOSERS.has(ch)) {
			if (depth === 0) return i;
			depth--;
			continue;
		}
		if (depth === 0) onTopLevel(ch, i);
	}
	if (depth !== 0) throw new Error("unbalanced brackets");
	return text.length;
}

/** Split a parameter list on its top-level commas; a trailing comma adds nothing. */
function splitTopLevel(rawList: string): string[] {
	const list = stripComments(rawList);
	const cuts: number[] = [];
	const end = scanTopLevel(list, 0, (ch, i) => {
		if (ch === ",") cuts.push(i);
	});
	if (end !== list.length) {
		throw new Error(`unbalanced "${list[end]}" in parameter list`);
	}
	const parts: string[] = [];
	let from = 0;
	for (const cut of [...cuts, list.length]) {
		parts.push(list.slice(from, cut).replace(/\s+/g, " ").trim());
		from = cut + 1;
	}
	return parts.filter((p) => p.length > 0);
}

/**
 * Parse the parameter list of a README API-table first cell, e.g.
 * "reduce(state, event, at?)". Returns `null` for a cell with no `(` (a
 * constant, class, or schema row). Throws on a cell it cannot read.
 */
export function parseReadmeParams(cell: string): Param[] | null {
	const open = cell.indexOf("(");
	if (open === -1) return null;
	if (!cell.endsWith(")")) {
		throw new Error(`README cell \`${cell}\` does not end in ")"`);
	}
	return splitTopLevel(cell.slice(open + 1, -1)).map((text) => {
		if (!/^[A-Za-z_$][\w$]*\??$/.test(text)) {
			throw new Error(
				`README cell \`${cell}\` has a parameter this check cannot read: "${text}" (expected a name, optionally followed by "?")`,
			);
		}
		return { text, optional: text.endsWith("?") };
	});
}

/** True when a declared parameter is optional: `name?: T`, or it has a default. */
function isOptionalDeclaredParam(text: string): boolean {
	if (/^[A-Za-z_$][\w$]*\s*\?/.test(text)) return true;
	let hasDefault = false;
	scanTopLevel(text, 0, (ch) => {
		if (ch === "=") hasDefault = true;
	});
	return hasDefault;
}

/** Index of the bracket that closes the one at `open`; throws if a different closer comes first. */
function matchingCloser(text: string, open: number): number {
	const close = scanTopLevel(text, open + 1, () => {});
	const expected = OPENERS[text[open]!];
	if (text[close] !== expected) {
		throw new Error(
			`unbalanced brackets: "${text[open]}" at offset ${open} is not closed by "${expected}"`,
		);
	}
	return close;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the parameters of `export function <localName>(…)` in a source
 * module. Throws, naming what it found, on any signature it cannot map to a
 * parameter list: no `export function` declaration (a const, class, or
 * further re-export), overloads, rest parameters, or a `this` parameter.
 * A destructured parameter counts as one positional parameter.
 */
export function parseDeclarationParams(
	source: string,
	localName: string,
): { params: Param[]; signature: string } {
	const declRe = new RegExp(
		`^export\\s+(?:async\\s+)?function\\s*\\*?\\s*${escapeRegExp(localName)}(?![\\w$])`,
		"gm",
	);
	const matches = [...source.matchAll(declRe)];
	if (matches.length === 0) {
		throw new Error(
			`no \`export function ${localName}\` declaration found — a const, class, or further re-export the arity check cannot follow`,
		);
	}
	if (matches.length > 1) {
		throw new Error(
			`${matches.length} \`export function ${localName}\` declarations — overloads, which the arity check cannot map to one parameter list`,
		);
	}

	let i = matches[0]!.index! + matches[0]![0].length;
	while (/\s/.test(source[i] ?? "")) i++;
	if (source[i] === "<") {
		// Generic type parameters: skip past the matching ">".
		i = matchingCloser(source, i) + 1;
		while (/\s/.test(source[i] ?? "")) i++;
	}
	if (source[i] !== "(") {
		throw new Error(
			`\`export function ${localName}\` is not followed by a parameter list`,
		);
	}
	const close = matchingCloser(source, i);
	const list = source.slice(i + 1, close);

	const params = splitTopLevel(list).map((text) => {
		if (text.startsWith("...")) {
			throw new Error(
				`\`${localName}\` has a rest parameter (${text}), which the arity check cannot map to a fixed parameter list`,
			);
		}
		if (/^this\s*[:?]/.test(text)) {
			throw new Error(
				`\`${localName}\` declares a \`this\` parameter (${text}), which the arity check cannot map`,
			);
		}
		return { text, optional: isOptionalDeclaredParam(text) };
	});
	return {
		params,
		signature: `${localName}(${params.map((p) => p.text).join(", ")})`,
	};
}

/** e.g. "3 required, 1 optional at position 4". */
function describeShape(params: Param[]): string {
	const optionalPositions = params
		.map((p, idx) => (p.optional ? idx + 1 : 0))
		.filter((pos) => pos > 0);
	const required = params.length - optionalPositions.length;
	if (optionalPositions.length === 0) return `${required} required, 0 optional`;
	const where = optionalPositions.length === 1 ? "position" : "positions";
	return `${required} required, ${optionalPositions.length} optional at ${where} ${optionalPositions.join(", ")}`;
}

/**
 * Compare a README row's parameter list to the declaration: same number of
 * parameters, and each position agreeing on required vs optional. Returns
 * `null` when they agree, else the failure message.
 */
export function compareArity(
	exportName: string,
	cell: string,
	readmeParams: Param[],
	declPath: string,
	decl: { params: Param[]; signature: string },
): string | null {
	const agrees =
		readmeParams.length === decl.params.length &&
		readmeParams.every((p, idx) => p.optional === decl.params[idx]!.optional);
	if (agrees) return null;
	return (
		`"${exportName}": README.md lists \`${cell}\` (${describeShape(readmeParams)}), ` +
		`but ${declPath} declares \`${decl.signature}\` (${describeShape(decl.params)}).`
	);
}
