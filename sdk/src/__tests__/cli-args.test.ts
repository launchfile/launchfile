import { describe, it, expect } from "vitest";
import {
	BOOLEAN_FLAGS,
	VALUE_FLAGS,
	getFlagValue,
	getPositional,
	suggestFlag,
	unknownFlags,
	valuedBooleanFlag,
} from "../cli-args.js";

describe("unknownFlags", () => {
	it("returns nothing for declared flags", () => {
		expect(unknownFlags(["validate", "--json", "--quiet", "--detached", "--no-color"])).toEqual([]);
	});

	it("accepts every flag in both tables", () => {
		expect(unknownFlags([...BOOLEAN_FLAGS, ...VALUE_FLAGS].map((f) => `--${f}=x`))).toEqual([]);
	});

	it("reports unknown flags in argv order, bare", () => {
		expect(unknownFlags(["--zzz", "validate", "--yyy=1"])).toEqual(["zzz", "yyy"]);
	});

	it("skips the token after a value flag", () => {
		expect(unknownFlags(["schema", "--schema-path", "--typo"])).toEqual([]);
		expect(unknownFlags(["schema", "--schema-path", "x.json", "--typo"])).toEqual(["typo"]);
	});

	it("does not judge single-dash tokens", () => {
		expect(unknownFlags(["-x", "-h"])).toEqual([]);
	});
});

describe("suggestFlag", () => {
	it("suggests on an edit distance of 2 or less", () => {
		expect(suggestFlag("jsonn")).toBe("json");
		expect(suggestFlag("detatched")).toBe("detached");
	});

	it("suggests on a single prefix match", () => {
		expect(suggestFlag("sch")).toBe("schema-path");
	});

	it("suggests nothing when the name is far from every flag", () => {
		expect(suggestFlag("frobnicate")).toBeUndefined();
	});

	it("suggests nothing on a tie", () => {
		expect(suggestFlag("qu")).toBe("quiet");
		expect(suggestFlag("")).toBeUndefined();
	});
});

describe("getFlagValue", () => {
	it("reads --flag value", () => {
		expect(getFlagValue(["schema", "--schema-path", "a.json"], "schema-path")).toBe("a.json");
	});

	it("reads --flag=value", () => {
		expect(getFlagValue(["schema", "--schema-path=a.json"], "schema-path")).toBe("a.json");
	});

	it("returns undefined when absent or when the flag is last", () => {
		expect(getFlagValue(["schema"], "schema-path")).toBeUndefined();
		expect(getFlagValue(["schema", "--schema-path"], "schema-path")).toBeUndefined();
	});
});

describe("getPositional", () => {
	it("skips flags and the value of a value flag", () => {
		const args = ["--schema-path", "a.json", "validate", "--json", "./Launchfile"];
		expect(getPositional(args, 0)).toBe("validate");
		expect(getPositional(args, 1)).toBe("./Launchfile");
		expect(getPositional(args, 2)).toBeUndefined();
	});

	it("does not skip after --flag=value", () => {
		expect(getPositional(["--schema-path=a.json", "schema"], 0)).toBe("schema");
	});
});

describe("valuedBooleanFlag", () => {
	it("returns the first boolean flag written with a value", () => {
		expect(valuedBooleanFlag(["validate", "--quiet=1", "--json=false"])).toBe("quiet");
	});

	it("returns undefined for bare boolean flags", () => {
		expect(valuedBooleanFlag(["validate", "--json", "--quiet"])).toBeUndefined();
	});

	it("ignores value flags and unknown flags with a value", () => {
		expect(valuedBooleanFlag(["schema", "--schema-path=a.json", "--typo=1"])).toBeUndefined();
	});

	it("ignores single-dash tokens", () => {
		expect(valuedBooleanFlag(["-j=1"])).toBeUndefined();
	});
});
