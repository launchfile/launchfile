import { describe, it, expect } from "vitest";
import { extractCaptures, parseDuration, computeAppProperties } from "../bootstrap.js";
import { readLaunch, resolveExpression, type CaptureEntry } from "@launchfile/sdk";

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

	it("throws on invalid input instead of substituting a default (PROVIDERS.md 10.10)", () => {
		expect(() => parseDuration("???")).toThrow(/invalid duration/);
		expect(() => parseDuration("")).toThrow(/invalid duration/);
	});

	it("rejects whitespace forms (ratified grammar, D-48)", () => {
		expect(() => parseDuration("5 m")).toThrow(/invalid duration/);
		expect(() => parseDuration(" 10s ")).toThrow(/invalid duration/);
	});
});

describe("computeAppProperties (D-33, D-35, docker provider)", () => {
	const launch = readLaunch(`
name: expr-in-command
components:
  default:
    image: nginx:alpine
    provides:
      - port: 8080
        protocol: http
    commands:
      bootstrap: "cli --url $app.url --authority $app.authority --tls $app.tls"
`);

	// The context bootstrap.ts and release.ts build for command-string resolution.
	const commandContext = (hostPorts: Record<string, number>) => ({
		secrets: {},
		app: computeAppProperties(launch, hostPorts),
	});

	it("supplies the full D-35 set, matching compose-generator's helper", () => {
		expect(computeAppProperties(launch, { default: 49200 })).toEqual({
			name: "expr-in-command",
			host: "localhost",
			port: 49200,
			url: "http://localhost:49200",
			authority: "localhost:49200",
			scheme: "http",
			tls: "false",
		});
	});

	it("resolves $app.authority / $app.scheme / $app.tls inside a bootstrap command string", () => {
		const command = launch.components.default!.commands!.bootstrap!.command;
		expect(resolveExpression(command, commandContext({ default: 49200 }))).toBe(
			"cli --url http://localhost:49200 --authority localhost:49200 --tls false",
		);
	});

	it("degrades the whole set to empty for an app with no exposed component", () => {
		const noPorts = readLaunch(`
name: headless
components:
  default:
    image: nginx:alpine
`);
		expect(computeAppProperties(noPorts, {})).toMatchObject({
			port: 0,
			url: "",
			authority: "",
			scheme: "",
			tls: "",
		});
	});
});
