import { describe, expect, it } from "vitest";
import {
	compareArity,
	getReadmeApiTableNames,
	getReadmeApiTableRows,
	getValueExportSources,
	getValueExports,
	parseDeclarationParams,
	parseExportStatements,
	parseReadmeParams,
	resolveSpecifier,
	sourcePathForSpecifier,
} from "./readme-exports.ts";

const INDEX = `
export { parse, type ParseOptions, serialize as write } from "./reader.ts";
export type { Launchfile } from "./types.ts";
export type * from "./more-types.ts";
`;

const README = `# SDK

## API

| Function | What it does |
|----------|--------------|
| \`parse(text)\` | Parses |
| \`write(x)\` | Serializes |

## Other

| \`ignored\` | not in the API section |
`;

describe("resolveSpecifier", () => {
	it("classifies value, type-keyword and aliased specifiers", () => {
		expect(resolveSpecifier("parse", false)).toEqual({
			name: "parse",
			localName: "parse",
			isValue: true,
		});
		expect(resolveSpecifier("type Foo", false).isValue).toBe(false);
		expect(resolveSpecifier("Foo", true).isValue).toBe(false);
		expect(resolveSpecifier("a as b", false)).toEqual({
			name: "b",
			localName: "a",
			isValue: true,
		});
	});
});

describe("getValueExports / getReadmeApiTableNames", () => {
	it("returns only value exports, under their exported names", () => {
		expect([...getValueExports(INDEX)].sort()).toEqual(["parse", "write"]);
	});

	it("reads names from the API table only", () => {
		expect([...getReadmeApiTableNames(README)].sort()).toEqual([
			"parse",
			"write",
		]);
	});

	it("reports a value export with no README row and no exclusion", () => {
		const source = `${INDEX}export { extra } from "./extra.ts";\n`;
		const exports = getValueExports(source);
		const documented = getReadmeApiTableNames(README);
		const unaccounted = [...exports].filter((n) => !documented.has(n));
		expect(unaccounted).toEqual(["extra"]);
	});

	it("reports README rows and exclusions that no longer match an export", () => {
		const exports = getValueExports(`export { parse } from "./reader.ts";\n`);
		const staleRows = [...getReadmeApiTableNames(README)].filter(
			(n) => !exports.has(n),
		);
		const staleExclusions = ["gone"].filter((n) => !exports.has(n));
		expect(staleRows).toEqual(["write"]);
		expect(staleExclusions).toEqual(["gone"]);
	});

	it("throws when the README has no API heading", () => {
		expect(() => getReadmeApiTableNames("# SDK\n")).toThrow(/## API/);
	});
});

describe("parseExportStatements", () => {
	it.each([
		'export * from "./a.ts";',
		"export function f() {}",
		"export const x = 1;",
		"export default 1;",
	])("throws naming the unparseable statement: %s", (source) => {
		expect(() => parseExportStatements(source)).toThrow(source);
	});

	it("accepts a type-only wildcard re-export", () => {
		expect(parseExportStatements('export type * from "./a.ts";')).toEqual([]);
	});
});

describe("getValueExportSources", () => {
	it("keeps each value export's source specifier and local name", () => {
		const sources = getValueExportSources(INDEX);
		expect(sources.get("parse")).toEqual({
			localName: "parse",
			from: "./reader.ts",
		});
		expect(sources.get("write")).toEqual({
			localName: "serialize",
			from: "./reader.ts",
		});
		expect(sources.has("ParseOptions")).toBe(false);
	});
});

describe("sourcePathForSpecifier", () => {
	it("maps a ./<module>.js specifier to its src/ file", () => {
		expect(sourcePathForSpecifier("./captures.js")).toBe("src/captures.ts");
		expect(sourcePathForSpecifier("./app-url.js")).toBe("src/app-url.ts");
	});

	it.each(["../outside.js", "some-package", "./nested/dir.js", "./a.ts"])(
		"throws for a specifier it cannot follow: %s",
		(from) => {
			expect(() => sourcePathForSpecifier(from)).toThrow(from);
		},
	);
});

describe("getReadmeApiTableRows", () => {
	it("maps each documented name to its first cell", () => {
		expect(getReadmeApiTableRows(README).get("parse")).toBe("parse(text)");
	});
});

describe("parseReadmeParams", () => {
	it("returns null for a row with no parameter list", () => {
		expect(parseReadmeParams("CAPTURE_MASK")).toBeNull();
	});

	it("reads required and optional parameters in order", () => {
		expect(
			parseReadmeParams(
				"formatCaptures(captures, captureMeta, reveal, options?)",
			),
		).toEqual([
			{ text: "captures", optional: false },
			{ text: "captureMeta", optional: false },
			{ text: "reveal", optional: false },
			{ text: "options?", optional: true },
		]);
		expect(parseReadmeParams("now()")).toEqual([]);
	});

	it.each(["f(a, ...rest)", "f({ a })", "f(a"])(
		"throws on a cell it cannot read: %s",
		(cell) => {
			expect(() => parseReadmeParams(cell)).toThrow();
		},
	);
});

const CAPTURES_TS = `
/** Formats captures. */
export function formatCaptures(
	captures: Record<string, string>,
	captureMeta: Record<string, CaptureEntry>,
	reveal: boolean,
	options: FormatCapturesOptions = {},
): string[] {
	return [];
}
`;

describe("parseDeclarationParams", () => {
	it("reads required, `?` and defaulted parameters", () => {
		const { params, signature } = parseDeclarationParams(
			CAPTURES_TS,
			"formatCaptures",
		);
		expect(params.map((p) => p.optional)).toEqual([false, false, false, true]);
		expect(signature).toBe(
			"formatCaptures(captures: Record<string, string>, captureMeta: Record<string, CaptureEntry>, reveal: boolean, options: FormatCapturesOptions = {})",
		);
		const reduce = parseDeclarationParams(
			"export function reduce(state: S, event: E, at?: string): S {}",
			"reduce",
		);
		expect(reduce.params.map((p) => p.optional)).toEqual([false, false, true]);
	});

	it("keeps commas inside types, defaults, strings and comments inside one parameter", () => {
		const source = `export async function f<T extends Map<string, number>>(
	a: (x: string, y: number) => void, // callback, called once
	b: { c?: string; d: [number, number] } = { d: [1, 2] },
	e = "x,y",
): Promise<void> {}`;
		const { params } = parseDeclarationParams(source, "f");
		expect(params.map((p) => p.optional)).toEqual([false, true, true]);
		expect(params[0]!.text).toBe("a: (x: string, y: number) => void");
	});

	it("throws on a destructured object parameter, naming the export", () => {
		expect(() =>
			parseDeclarationParams(
				"export function useKeyOf({ use, name }: DeclaredUse): string {}",
				"useKeyOf",
			),
		).toThrow(/`useKeyOf` has a destructured parameter/);
	});

	it("throws on a destructured array parameter, naming the export", () => {
		expect(() =>
			parseDeclarationParams(
				"export function first(a: string, [b, c]: [number, number]): void {}",
				"first",
			),
		).toThrow(/`first` has a destructured parameter/);
	});

	it("does not match a longer name that shares the prefix", () => {
		const source =
			"export function useKeys(a: A): void {}\nexport function useKey(item: I): void {}";
		expect(parseDeclarationParams(source, "useKey").params).toHaveLength(1);
	});

	it.each([
		["a const", "export const f = (a: string) => a;", /no `export function f`/],
		["a class", "export class f {}", /no `export function f`/],
		[
			"a further re-export",
			'export { f } from "../elsewhere.js";',
			/no `export function f`/,
		],
		[
			"overloads",
			"export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: unknown) { return a; }",
			/overloads/,
		],
		[
			"a rest parameter",
			"export function f(a: string, ...rest: string[]) {}",
			/rest parameter/,
		],
		[
			"a default it cannot bracket-match",
			"export function f(a: number, b = a > 1 ? 1 : 0, c?: string) {}",
			/unbalanced/,
		],
		[
			"a this parameter",
			"export function f(this: Foo, a: string) {}",
			/`this` parameter/,
		],
	])("throws, naming the export, on %s", (_label, source, message) => {
		expect(() => parseDeclarationParams(source, "f")).toThrow(message);
	});
});

describe("compareArity", () => {
	const decl = parseDeclarationParams(CAPTURES_TS, "formatCaptures");

	it("passes when count and optional positions agree", () => {
		const cell = "formatCaptures(captures, captureMeta, reveal, options?)";
		expect(
			compareArity(
				"formatCaptures",
				cell,
				parseReadmeParams(cell)!,
				"src/captures.ts",
				decl,
			),
		).toBeNull();
	});

	it("fails a row that drops a required parameter, printing both lists", () => {
		const cell = "formatCaptures(captures, captureMeta, options?)";
		const message = compareArity(
			"formatCaptures",
			cell,
			parseReadmeParams(cell)!,
			"src/captures.ts",
			decl,
		);
		expect(message).toContain('"formatCaptures"');
		expect(message).toContain(
			"`formatCaptures(captures, captureMeta, options?)`",
		);
		expect(message).toContain("2 required, 1 optional at position 3");
		expect(message).toContain("reveal: boolean");
		expect(message).toContain("3 required, 1 optional at position 4");
	});

	it("fails a row with the right count but an optional in the wrong position", () => {
		const cell = "formatCaptures(captures, captureMeta?, reveal, options)";
		expect(
			compareArity(
				"formatCaptures",
				cell,
				parseReadmeParams(cell)!,
				"src/captures.ts",
				decl,
			),
		).toContain("optional at position 2");
	});

	it("fails a row that marks a required parameter optional", () => {
		const cell = "formatCaptures(captures, captureMeta, reveal?, options?)";
		expect(
			compareArity(
				"formatCaptures",
				cell,
				parseReadmeParams(cell)!,
				"src/captures.ts",
				decl,
			),
		).not.toBeNull();
	});
});
