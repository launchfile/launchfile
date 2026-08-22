import { describe, it, expect } from "vitest";
import { parseDuration as parseHealthDuration } from "../health.js";
import { extractCaptures, parseDuration } from "../bootstrap.js";
import type { CaptureEntry } from "@launchfile/sdk";

describe("extractCaptures (D-34)", () => {
	it("extracts a single-group regex from stdout", () => {
		const captures: Record<string, CaptureEntry> = {
			invite_link: {
				pattern: "https?://\\S+",
				description: "One-time invite link",
				sensitive: true,
			},
		};
		const stdout =
			"Admin created.\nInvite URL: https://example.com/invite/abc123\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			invite_link: "https://example.com/invite/abc123",
		});
	});

	it("uses first capture group when present", () => {
		const captures: Record<string, CaptureEntry> = {
			password: {
				pattern: "Admin password: (.+)",
			},
		};
		const stdout = "Admin password: s3cret!\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			password: "s3cret!",
		});
	});

	it("returns empty result when no patterns match", () => {
		const captures: Record<string, CaptureEntry> = {
			token: { pattern: "token=(\\S+)" },
		};
		expect(extractCaptures("nothing to see here", captures)).toEqual({});
	});

	it("strips ANSI escape codes before matching", () => {
		const captures: Record<string, CaptureEntry> = {
			url: { pattern: "https?://\\S+" },
		};
		// Simulates colorized output from a CLI tool that detects a TTY
		const stdout =
			"\x1b[32mSuccess:\x1b[0m visit \x1b[4mhttps://example.com/admin\x1b[0m to continue";
		expect(extractCaptures(stdout, captures)).toEqual({
			url: "https://example.com/admin",
		});
	});

	it("skips invalid regex without throwing", () => {
		const captures: Record<string, CaptureEntry> = {
			bad: { pattern: "(unclosed" },
			good: { pattern: "ok" },
		};
		const result = extractCaptures("ok here", captures);
		// good matches; bad is skipped
		expect(result.good).toBe("ok");
		expect(result.bad).toBeUndefined();
	});

	it("handles multiple captures in one stdout", () => {
		const captures: Record<string, CaptureEntry> = {
			user: { pattern: "user=(\\S+)" },
			pw: { pattern: "pw=(\\S+)" },
		};
		const stdout = "Created user=alice pw=hunter2 expires=1h\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			user: "alice",
			pw: "hunter2",
		});
	});

	it("returns full match when pattern has no capture group", () => {
		const captures: Record<string, CaptureEntry> = {
			hash: { pattern: "[a-f0-9]{8}" },
		};
		const stdout = "Commit: deadbeef\n";
		expect(extractCaptures(stdout, captures)).toEqual({
			hash: "deadbeef",
		});
	});
});

describe("parseDuration", () => {
	it("parses ms, s, m, h units", () => {
		expect(parseDuration("500ms")).toBe(500);
		expect(parseDuration("30s")).toBe(30_000);
		expect(parseDuration("5m")).toBe(300_000);
		expect(parseDuration("2h")).toBe(7_200_000);
	});

	it("rejects whitespace forms (ratified grammar, D-48)", () => {
		expect(() => parseDuration(" 10s ")).toThrow(/invalid duration/);
		expect(() => parseDuration("5 m")).toThrow(/invalid duration/);
	});

	it("throws on invalid input instead of substituting a default (PROVIDERS.md 10.10)", () => {
		expect(() => parseDuration("bogus")).toThrow(/invalid duration/);
		expect(() => parseDuration("")).toThrow(/invalid duration/);
	});
});

describe("health durations use the ratified grammar (D-48)", () => {
	it("accepts the hour unit the local parser used to drop", () => {
		// The old health.ts regex was ^(\d+)(ms|s|m)$ with a silent `return 0`,
		// so a spec-valid `interval: "1h"` became a zero-length poll that could
		// never pass — a P-5 divergence from Docker on a value validate accepts.
		expect(parseHealthDuration("1h")).toBe(3_600_000);
		expect(parseHealthDuration("2h")).toBe(7_200_000);
	});

	it("still parses the units it always did", () => {
		expect(parseHealthDuration("500ms")).toBe(500);
		expect(parseHealthDuration("30s")).toBe(30_000);
		expect(parseHealthDuration("5m")).toBe(300_000);
	});

	it("throws rather than silently substituting a default", () => {
		// PROVIDERS.md §10.10: a provider MUST NOT substitute for an unparseable
		// duration. The old parser returned 0 here.
		expect(() => parseHealthDuration("5 minutes")).toThrow(/invalid duration/);
		expect(() => parseHealthDuration("1.5h")).toThrow(/invalid duration/);
		expect(() => parseHealthDuration("30 s")).toThrow(/invalid duration/);
	});
});
