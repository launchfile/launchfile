/**
 * The two `launchUp` failures that throw instead of exiting: a missing
 * prerequisite (`prereq`) and a missing `Launchfile` (`resolve`).
 *
 * They are the earliest two failure points, so they are also the two most
 * likely to be a user's first experience of the tool, and the only two whose
 * control flow this feature changed. A record only exists for them because
 * they throw, so the phase and the key on the thrown error are the contract —
 * `launchfile diagnose` finds nothing if either is wrong.
 *
 * The mock set mirrors operator-storage.test.ts: real subprocess exec and a
 * real pm2 registration have no place in a unit test. `checkPrereqs` is the
 * exception — it is the subject here, so it is driven from `mocks.prereq`
 * rather than pinned to a passing result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLaunchError, sourceErrorKey } from "@launchfile/sdk";

const mocks = vi.hoisted(() => ({
	prereq: { ok: true, missing: [] as string[] },
}));

vi.mock("../prereqs.js", () => ({
	checkPrereqs: async () => mocks.prereq,
}));

vi.mock("../runtimes/index.js", () => ({
	getRuntimeInstaller: () => undefined,
}));

vi.mock("../shell.js", () => ({
	shell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	shellOk: async () => true,
	shellScript: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
}));

vi.mock("../process-manager.js", () => ({
	ProcessManager: class {
		register() {}
		async startAll() {}
		async stopAll() {}
		getRecordedProcesses() {
			return {};
		}
	},
}));

const { launchUp } = await import("../provider.js");

const VALID = `
name: app
runtime: node
commands:
  start: "node server.js"
`;

describe("launchUp — the two failures that throw rather than exit", () => {
	let projectDir: string;
	let consoleErrors: string[];
	let exitCode: number | undefined;

	beforeEach(() => {
		mocks.prereq = { ok: true, missing: [] };
		consoleErrors = [];
		exitCode = undefined;
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-throw-"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			consoleErrors.push(args.map(String).join(" "));
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCode = code;
			throw new Error(`__exit__${code}`);
		}) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("tags a missing prerequisite `prereq`, keyed by project directory", async () => {
		mocks.prereq = { ok: false, missing: ["Homebrew is not installed"] };
		writeFileSync(join(projectDir, "Launchfile"), VALID);

		const err = await launchUp({ projectDir }).catch((e: unknown) => e);

		expect(isLaunchError(err)).toBe(true);
		if (!isLaunchError(err)) return;
		expect(err.context.phase).toBe("prereq");
		expect(err.context.key).toBe(sourceErrorKey(projectDir));
		expect(err.message).toBe("Missing prerequisites: Homebrew is not installed");
	});

	it("still prints the itemized prerequisite list, and does not exit", async () => {
		// The throw replaced a `process.exit(1)`. The itemized list is the
		// actionable half of the diagnosis and has to survive that swap; the CLI's
		// top-level handler supplies the non-zero exit.
		mocks.prereq = { ok: false, missing: ["Homebrew is not installed", "git is not installed"] };
		writeFileSync(join(projectDir, "Launchfile"), VALID);

		await expect(launchUp({ projectDir })).rejects.toThrow("Missing prerequisites");

		expect(consoleErrors).toContain("Missing prerequisites:");
		expect(consoleErrors).toContain("  - Homebrew is not installed");
		expect(consoleErrors).toContain("  - git is not installed");
		expect(exitCode).toBeUndefined();
	});

	it("tags a missing Launchfile `resolve`, keyed by project directory", async () => {
		const err = await launchUp({ projectDir }).catch((e: unknown) => e);

		expect(isLaunchError(err)).toBe(true);
		if (!isLaunchError(err)) return;
		expect(err.context.phase).toBe("resolve");
		expect(err.context.key).toBe(sourceErrorKey(projectDir));
		expect(err.message).toBe(`No Launchfile found at ${join(projectDir, "Launchfile")}`);
		expect(consoleErrors).toContain(`No Launchfile found at ${join(projectDir, "Launchfile")}`);
		expect(exitCode).toBeUndefined();
	});

	it("checks prerequisites before it looks for a Launchfile", async () => {
		// Order matters for the phase: an empty directory on a machine with no
		// Homebrew must record `prereq`, not `resolve`.
		mocks.prereq = { ok: false, missing: ["Homebrew is not installed"] };

		const err = await launchUp({ projectDir }).catch((e: unknown) => e);

		expect(isLaunchError(err)).toBe(true);
		if (!isLaunchError(err)) return;
		expect(err.context.phase).toBe("prereq");
	});
});
