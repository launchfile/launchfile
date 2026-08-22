import { describe, it, expect } from "vitest";
import { extractCaptures, parseDuration } from "../bootstrap.js";
import type { CaptureEntry } from "@launchfile/sdk";

describe("extractCaptures (D-34, docker provider)", () => {
	it("extracts invite link pattern from CLI output", () => {
		const captures: Record<string, CaptureEntry> = {
			invite_link: {
				pattern: "https?://\\S+",
				sensitive: true,
			},
		};
		const stdout = "Created invite\nhttps://example.com/invite/xyz\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			invite_link: "https://example.com/invite/xyz",
		});
	});

	it("strips ANSI before matching (docker compose exec pty output)", () => {
		const captures: Record<string, CaptureEntry> = {
			token: { pattern: "token=(\\S+)" },
		};
		const stdout = "\x1b[1mGenerated:\x1b[0m token=s3cret\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			token: "s3cret",
		});
	});

	it("returns empty object when no patterns match", () => {
		const captures: Record<string, CaptureEntry> = {
			nope: { pattern: "definitely-not-present" },
		};
		expect(extractCaptures("hello world", captures)).toEqual({});
	});

	it("silently skips invalid regex", () => {
		const captures: Record<string, CaptureEntry> = {
			bad: { pattern: "(unclosed" },
			ok: { pattern: "hello" },
		};
		const result = extractCaptures("hello", captures);
		expect(result.ok).toBe("hello");
		expect(result.bad).toBeUndefined();
	});

	it("supports multi-line captures across the command output", () => {
		const captures: Record<string, CaptureEntry> = {
			first: { pattern: "step1: (\\w+)" },
			second: { pattern: "step2: (\\w+)" },
		};
		const stdout = "step1: alpha\nstep2: beta\nstep3: done\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			first: "alpha",
			second: "beta",
		});
	});
});

describe("parseDuration (docker provider)", () => {
	it("parses ms/s/m/h units", () => {
		expect(parseDuration("500ms")).toBe(500);
		expect(parseDuration("45s")).toBe(45_000);
		expect(parseDuration("3m")).toBe(180_000);
		expect(parseDuration("1h")).toBe(3_600_000);
	});

	it("throws on invalid input instead of substituting a default (PROVIDERS.md 10.11)", () => {
		expect(() => parseDuration("???")).toThrow(/invalid duration/);
		expect(() => parseDuration("")).toThrow(/invalid duration/);
	});

	it("rejects whitespace forms (ratified grammar, D-48)", () => {
		expect(() => parseDuration("5 m")).toThrow(/invalid duration/);
		expect(() => parseDuration(" 10s ")).toThrow(/invalid duration/);
	});
});
