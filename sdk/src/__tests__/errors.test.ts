import { describe, expect, it } from "vitest";
import {
	buildLaunchErrorContext,
	commandForSlot,
	dispositionForPhase,
	envKeysOf,
	LAUNCH_PHASES,
	LaunchError,
	isLaunchError,
	MAX_LINE_CHARS,
	parseLaunchErrorContext,
	slotForCommand,
	stripControl,
	TAIL_LINES,
	tailLines,
} from "../errors.js";

const IDENTITY = (s: string): string => s;

describe("dispositionForPhase — the D-48 table", () => {
	it("fails the invocation for prepare and run", () => {
		expect(dispositionForPhase("prepare")).toBe("failed-invocation");
		expect(dispositionForPhase("run")).toBe("failed-invocation");
	});

	it("fails the deploy for release", () => {
		expect(dispositionForPhase("release")).toBe("failed-deploy");
	});

	it("reports bootstrap and on-demand without affecting deploy status", () => {
		expect(dispositionForPhase("bootstrap")).toBe("reported");
		expect(dispositionForPhase("on-demand")).toBe("reported");
	});

	it("fails the invocation when a component never becomes healthy", () => {
		expect(dispositionForPhase("health")).toBe("failed-invocation");
	});

	it("gives every phase a disposition", () => {
		for (const phase of LAUNCH_PHASES) {
			expect(dispositionForPhase(phase)).toBeTruthy();
		}
	});
});

describe("slot mapping across modes (the D-38 case)", () => {
	// The ambiguity D-48 keys slots to avoid: `build` and `start` each appear in
	// two modes. Keyed on the slot, each names one thing in both.
	it("maps build to prepare and start to run regardless of mode", () => {
		expect(slotForCommand("build")).toBe("prepare");
		expect(slotForCommand("install")).toBe("prepare");
		expect(slotForCommand("start")).toBe("run");
		expect(slotForCommand("dev")).toBe("run");
	});

	it("resolves the prepare slot to install ?? build in source mode", () => {
		const declared = ["install", "build", "start", "dev"];
		expect(commandForSlot("prepare", "source", declared)).toBe("install");
		expect(commandForSlot("prepare", "source", ["build", "start"])).toBe("build");
		expect(commandForSlot("prepare", "artifact", declared)).toBe("build");
	});

	it("resolves the run slot to dev ?? start in source mode", () => {
		expect(commandForSlot("run", "source", ["dev", "start"])).toBe("dev");
		// A component declaring only `start:` fills the run slot in source mode.
		expect(commandForSlot("run", "source", ["start"])).toBe("start");
		expect(commandForSlot("run", "artifact", ["dev", "start"])).toBe("start");
	});

	it("routes seed, test, and custom commands to on-demand", () => {
		expect(slotForCommand("seed")).toBe("on-demand");
		expect(slotForCommand("test")).toBe("on-demand");
		expect(slotForCommand("smoke")).toBe("on-demand");
		expect(dispositionForPhase(slotForCommand("seed"))).toBe("reported");
	});

	it("routes bootstrap to a reported disposition in both modes", () => {
		expect(slotForCommand("bootstrap")).toBe("bootstrap");
		expect(commandForSlot("bootstrap", "source", ["bootstrap"])).toBe("bootstrap");
		expect(commandForSlot("bootstrap", "artifact", ["bootstrap"])).toBe("bootstrap");
		expect(dispositionForPhase("bootstrap")).toBe("reported");
	});
});

describe("buildLaunchErrorContext — redaction at capture", () => {
	const redact = (s: string): string => s.split("hunter2").join("[REDACTED]");

	it("runs the redactor over every free-text field", () => {
		const ctx = buildLaunchErrorContext(
			{
				phase: "release",
				provider: "docker",
				key: "demo",
				message: "Command failed: psql hunter2",
				command: "psql hunter2",
				stdout: "connecting with hunter2",
				stderr: "auth failed for hunter2",
				serviceLogs: { web: "boot: hunter2" },
				warnings: ["schedule not run: hunter2"],
			},
			redact,
		);

		const serialized = JSON.stringify(ctx);
		expect(serialized).not.toContain("hunter2");
		expect(ctx.command).toBe("psql [REDACTED]");
		expect(ctx.serviceLogs?.web).toBe("boot: [REDACTED]");
	});

	it("derives disposition from phase at capture time", () => {
		const ctx = buildLaunchErrorContext(
			{ phase: "release", provider: "docker", key: "k", message: "boom" },
			IDENTITY,
		);
		expect(ctx.disposition).toBe("failed-deploy");
		expect(ctx.version).toBe(1);
	});

	it("keeps env names and drops every env value (sentinel)", () => {
		const sentinel = "sentinel-4f2b8c19-do-not-persist";
		const ctx = buildLaunchErrorContext(
			{
				phase: "run",
				provider: "docker",
				key: "k",
				message: "boom",
				env: { API_KEY: sentinel, DATABASE_URL: `postgres://u:${sentinel}@h/db` },
			},
			IDENTITY,
		);

		expect(ctx.envKeys).toEqual(["API_KEY", "DATABASE_URL"]);
		expect(JSON.stringify(ctx)).not.toContain(sentinel);
	});

	it("strips ANSI escapes and control characters", () => {
		const esc = String.fromCharCode(27);
		const bell = String.fromCharCode(7);
		const ctx = buildLaunchErrorContext(
			{
				phase: "run",
				provider: "docker",
				key: "k",
				message: `${esc}[31mred${esc}[0m${bell}\rtext`,
			},
			IDENTITY,
		);
		expect(ctx.message).toBe("redtext");
	});

	it("keeps only the last 200 lines of a captured tail", () => {
		const long = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n");
		const ctx = buildLaunchErrorContext(
			{ phase: "run", provider: "docker", key: "k", message: "boom", stderr: long },
			IDENTITY,
		);
		const lines = ctx.stderr!.split("\n");
		expect(lines).toHaveLength(TAIL_LINES);
		expect(lines[0]).toBe("line-300");
		expect(lines.at(-1)).toBe("line-499");
	});

	it("caps a single very long line after redacting it", () => {
		const secret = "s".repeat(20);
		const line = `${"x".repeat(MAX_LINE_CHARS)}${secret}`;
		const ctx = buildLaunchErrorContext(
			{ phase: "run", provider: "docker", key: "k", message: "boom", stdout: line },
			(s) => s.split(secret).join("[REDACTED]"),
		);
		expect(ctx.stdout).not.toContain(secret);
		expect(ctx.stdout!.length).toBe(MAX_LINE_CHARS + 1);
	});
});

describe("LaunchError", () => {
	it("carries the context and reports as a LaunchError", () => {
		const ctx = buildLaunchErrorContext(
			{ phase: "prereq", provider: "docker", key: "k", message: "docker is not running" },
			IDENTITY,
		);
		const err = new LaunchError(ctx);
		expect(err.message).toBe("docker is not running");
		expect(isLaunchError(err)).toBe(true);
		expect(isLaunchError(new Error("plain"))).toBe(false);
		expect(err.context.phase).toBe("prereq");
	});
});

describe("parseLaunchErrorContext", () => {
	it("round-trips a written record", () => {
		const ctx = buildLaunchErrorContext(
			{
				phase: "release",
				provider: "docker",
				key: "demo",
				message: "boom",
				env: { A: "1", B: "2" },
				unsupplied: [{ component: "web", variable: "SMTP_URL" }],
				warnings: ["reaper: declares a schedule"],
			},
			IDENTITY,
		);
		const parsed = parseLaunchErrorContext(JSON.parse(JSON.stringify(ctx)));
		expect(parsed).toEqual(ctx);
		expect(parsed?.envKeys).toEqual(["A", "B"]);
	});

	it("rejects anything that is not a launch error record", () => {
		expect(parseLaunchErrorContext(null)).toBeNull();
		expect(parseLaunchErrorContext("{}")).toBeNull();
		expect(parseLaunchErrorContext({ version: 2 })).toBeNull();
		expect(parseLaunchErrorContext({ version: 1, phase: "nope" })).toBeNull();
		expect(
			parseLaunchErrorContext({ version: 1, phase: "run", message: "m", provider: "docker" }),
		).toBeNull();
	});
});

describe("helpers", () => {
	it("tailLines returns the text unchanged when short enough", () => {
		expect(tailLines("a\nb", 5)).toBe("a\nb");
	});

	it("stripControl keeps tabs and newlines", () => {
		expect(stripControl("a\tb\nc")).toBe("a\tb\nc");
	});

	it("envKeysOf sorts and drops values", () => {
		expect(envKeysOf({ b: "2", a: "1" })).toEqual(["a", "b"]);
	});
});
