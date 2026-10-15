/**
 * `launchUp` rejects when a component's process exits non-zero before it
 * came up (issue #526, SPEC.md § Failure semantics, run slot), whether or not
 * the file declares `health:`. The rejection carries the `run` phase, and
 * "All components started" is never printed on that path.
 *
 * The real `ProcessManager` spawns a real `sh`; the same collaborators as
 * up-health-fails.test.ts are replaced, so the launch runs against a real
 * temp project directory without brew, runtimes, or a live health probe.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLaunchError } from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prereqs.js", () => ({
	checkPrereqs: async () => ({ ok: true, missing: [] }),
}));

vi.mock("../runtimes/index.js", () => ({
	getRuntimeInstaller: () => undefined,
}));

vi.mock("../shell.js", () => ({
	shell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	shellOk: async () => true,
	shellScript: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
}));

const { launchUp } = await import("../provider.js");
const { loadState } = await import("../state.js");
const { realSignalFns, stopRecordedProcesses } = await import(
	"../process-stopper.js"
);

const EXITS_ON_START = `
name: app
runtime: node
commands:
  start: "echo boom >&2; exit 1"
`;

describe("launchUp fails the invocation when a component exits before coming up (#526)", () => {
	let projectDir: string;
	const logged: string[] = [];
	const errors: string[] = [];

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "launchfile-up-exit-"));
		logged.length = 0;
		errors.length = 0;
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});
	});

	afterEach(async () => {
		const recorded = (await loadState(projectDir))?.processes ?? {};
		await stopRecordedProcesses(recorded, realSignalFns, { graceMs: 100 });
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("rejects with the run phase, naming the component and its exit code", async () => {
		writeFileSync(join(projectDir, "Launchfile"), EXITS_ON_START);

		const err = await launchUp({ projectDir }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe(
			"component(s) exited before coming up: default (exit code 1)",
		);
		expect(isLaunchError(err)).toBe(true);
		if (isLaunchError(err)) {
			expect(err.context.phase).toBe("run");
			expect(err.context.disposition).toBe("failed-invocation");
			expect(err.context.provider).toBe("macos-dev");
			expect(err.context.app).toBe("app");
		}

		expect(logged.join("\n")).not.toContain("All components started");
		expect(errors.join("\n")).toContain("No component is left running.");

		// The spawn is recorded even though it is gone, so `down` can answer
		// "already dead" rather than "never started".
		const recorded = (await loadState(projectDir))?.processes ?? {};
		expect(Object.keys(recorded)).toEqual(["default"]);
		const outcomes = await stopRecordedProcesses(recorded, realSignalFns, {
			graceMs: 100,
		});
		expect(outcomes).toEqual([
			expect.objectContaining({ component: "default", result: "already-dead" }),
		]);
	});
});
