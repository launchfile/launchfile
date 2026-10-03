import { describe, expect, it } from "vitest";
import {
	getReadmeApiTableNames,
	getValueExports,
	parseExportStatements,
	resolveSpecifier,
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
			isValue: true,
		});
		expect(resolveSpecifier("type Foo", false).isValue).toBe(false);
		expect(resolveSpecifier("Foo", true).isValue).toBe(false);
		expect(resolveSpecifier("a as b", false)).toEqual({
			name: "b",
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
