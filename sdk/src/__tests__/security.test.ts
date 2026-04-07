import { describe, it, expect } from "vitest";
import { readLaunch } from "../reader.js";
import { parseDotPath } from "../resolver.js";
import { LaunchSchema, NameSchema, OutputSchema } from "../schema.js";

describe("YAML parser hardening", () => {
	it("rejects input exceeding 1 MB", () => {
		const huge = "name: a\n" + "x".repeat(1_048_577);
		expect(() => readLaunch(huge)).toThrow("maximum size");
	});

	it("rejects excessive YAML alias expansion", () => {
		// Build a YAML bomb with chained aliases exceeding maxAliasCount
		let yaml = "name: test-app\n";
		yaml += "a0: &a0\n  x: y\n";
		for (let i = 1; i <= 120; i++) {
			yaml += `a${i}: &a${i}\n  ref: *a${i - 1}\n`;
		}
		expect(() => readLaunch(yaml)).toThrow();
	});

	it("accepts normal YAML with a few aliases", () => {
		const yaml = `
name: test-app
runtime: node
a: &defaults
  x: y
b: *defaults
`;
		// Should not throw — well within alias limits
		expect(() => readLaunch(yaml)).not.toThrow();
	});
});

describe("expression path depth limit", () => {
	it("rejects paths with more than 10 segments", () => {
		expect(() => parseDotPath("a.b.c.d.e.f.g.h.i.j.k")).toThrow("maximum of 10 segments");
	});

	it("accepts paths with exactly 10 segments", () => {
		const segments = parseDotPath("a.b.c.d.e.f.g.h.i.j");
		expect(segments).toHaveLength(10);
	});

	it("accepts normal 3-segment paths", () => {
		const segments = parseDotPath("components.backend.url");
		expect(segments).toEqual(["components", "backend", "url"]);
	});
});

describe("schema string length limits", () => {
	it("rejects names longer than 63 characters", () => {
		expect(() => NameSchema.parse("a".repeat(64))).toThrow();
	});

	it("accepts names up to 63 characters", () => {
		expect(() => NameSchema.parse("a".repeat(63))).not.toThrow();
	});

	it("rejects descriptions longer than 4096 characters", () => {
		expect(() =>
			LaunchSchema.parse({
				name: "test",
				description: "x".repeat(4097),
			}),
		).toThrow();
	});

	it("rejects commands longer than 10240 characters", () => {
		expect(() =>
			LaunchSchema.parse({
				name: "test",
				commands: { start: "x".repeat(10241) },
			}),
		).toThrow();
	});

	it("rejects image strings longer than 1024 characters", () => {
		expect(() =>
			LaunchSchema.parse({
				name: "test",
				image: "x".repeat(1025),
			}),
		).toThrow();
	});
});

describe("output pattern regex validation", () => {
	it("rejects invalid regex patterns", () => {
		expect(() =>
			OutputSchema.parse({ pattern: "(unclosed" }),
		).toThrow();
	});

	it("rejects patterns longer than 1024 characters", () => {
		expect(() =>
			OutputSchema.parse({ pattern: "a".repeat(1025) }),
		).toThrow();
	});

	it("accepts valid regex patterns", () => {
		expect(() =>
			OutputSchema.parse({ pattern: "version:\\s+(\\d+\\.\\d+\\.\\d+)" }),
		).not.toThrow();
	});

	it("accepts simple capture group patterns", () => {
		expect(() =>
			OutputSchema.parse({ pattern: "URL: (https?://\\S+)" }),
		).not.toThrow();
	});
});
