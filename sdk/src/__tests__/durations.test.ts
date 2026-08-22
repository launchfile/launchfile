import { describe, expect, it } from "vitest";
import {
	isValidDuration,
	lintDurations,
	parseDurationMs,
} from "../durations.js";
import { lintLaunch } from "../lint.js";
import { readLaunch } from "../reader.js";

describe("isValidDuration", () => {
	it("accepts the four units", () => {
		expect(isValidDuration("500ms")).toBe(true);
		expect(isValidDuration("30s")).toBe(true);
		expect(isValidDuration("5m")).toBe(true);
		expect(isValidDuration("2h")).toBe(true);
	});

	it("rejects internal whitespace (the tightening over shipped parsers)", () => {
		expect(isValidDuration("5 m")).toBe(false);
		expect(isValidDuration("30 s")).toBe(false);
	});

	it("rejects surrounding whitespace, compounds, fractions, and bare numbers", () => {
		expect(isValidDuration(" 30s")).toBe(false);
		expect(isValidDuration("30s ")).toBe(false);
		expect(isValidDuration("1m30s")).toBe(false);
		expect(isValidDuration("1.5m")).toBe(false);
		expect(isValidDuration("30")).toBe(false);
		expect(isValidDuration("")).toBe(false);
		expect(isValidDuration("5d")).toBe(false);
	});
});

describe("parseDurationMs", () => {
	it("converts each unit to milliseconds", () => {
		expect(parseDurationMs("500ms")).toBe(500);
		expect(parseDurationMs("30s")).toBe(30_000);
		expect(parseDurationMs("5m")).toBe(300_000);
		expect(parseDurationMs("2h")).toBe(7_200_000);
	});

	it("throws on an unparseable value instead of substituting a default", () => {
		expect(() => parseDurationMs("bogus")).toThrow(/invalid duration "bogus"/);
		expect(() => parseDurationMs("5 m")).toThrow(/invalid duration/);
		expect(() => parseDurationMs("")).toThrow(/invalid duration/);
	});
});

describe("lintDurations", () => {
	it("returns no warnings for valid durations", () => {
		const launch = readLaunch(`
name: acme
image: acme:latest
commands:
  release:
    command: "migrate"
    timeout: "5m"
health:
  path: /health
  interval: 30s
  timeout: 5s
  start_period: 1m
`);
		expect(lintDurations(launch)).toEqual([]);
	});

	it("warns on an unparseable commands.*.timeout", () => {
		const launch = readLaunch(`
name: acme
image: acme:latest
commands:
  release:
    command: "migrate"
    timeout: "5 minutes"
`);
		const warnings = lintDurations(launch);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("commands.release.timeout");
		expect(warnings[0]).toContain('"5 minutes"');
	});

	it("warns on each unparseable health duration", () => {
		const launch = readLaunch(`
name: acme
image: acme:latest
health:
  path: /health
  interval: "10 s"
  timeout: soon
  start_period: 45s
`);
		const warnings = lintDurations(launch);
		expect(warnings).toHaveLength(2);
		expect(warnings.join("\n")).toContain("health.interval");
		expect(warnings.join("\n")).toContain("health.timeout");
		expect(warnings.join("\n")).not.toContain("start_period");
	});

	it("prefixes the component name for multi-component apps", () => {
		const launch = readLaunch(`
name: acme
components:
  api:
    image: api:latest
    commands:
      bootstrap:
        command: "setup"
        timeout: "2 h"
`);
		const warnings = lintDurations(launch);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("api: commands.bootstrap.timeout");
	});

	it("is surfaced through lintLaunch (the validate warning channel)", () => {
		const launch = readLaunch(`
name: acme
image: acme:latest
commands:
  build:
    command: "make"
    timeout: "1 day"
`);
		const warnings = lintLaunch(launch);
		expect(warnings.some((w) => w.includes("commands.build.timeout"))).toBe(
			true,
		);
	});
});
