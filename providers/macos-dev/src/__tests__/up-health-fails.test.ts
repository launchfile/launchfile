/**
 * `launchUp` rejects when a component never becomes healthy (issue #376,
 * SPEC.md § Failure semantics), and records the pid it spawned on that path
 * so `down` still reaches the process it left running.
 *
 * The real `ProcessManager` spawns a real `sleep`; only the poll itself is
 * replaced (`waitForHealthy` reports "never passed" at once, so the test does
 * not wait out the 60s budget — health-gate.test.ts polls for real). Every
 * other collaborator runs against a real temp project directory, following
 * provider-required-env.test.ts. Cleanup goes through the same
 * `stopRecordedProcesses` that `launchDown` calls, with a short grace period
 * instead of down's 5s one.
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

vi.mock("../health.js", () => ({
	parseDuration: () => 0,
	healthCheckNeedsPort: () => true,
	describeHealthCheck: (_health: unknown, port: number | undefined) =>
		`GET http://localhost:${port}/healthz`,
	waitForHealthy: async () => false,
}));

const { launchUp } = await import("../provider.js");
const { loadState } = await import("../state.js");
const { realSignalFns, stopRecordedProcesses } = await import("../process-stopper.js");

const NEVER_HEALTHY = `
name: app
runtime: node
commands:
  start: "sleep 30"
health:
  path: /healthz
`;

const NO_HEALTH = `
name: app
runtime: node
commands:
  start: "sleep 30"
`;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("launchUp fails the invocation when a component never becomes healthy (#376)", () => {
	let projectDir: string;
	const logged: string[] = [];

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "launchfile-up-health-"));
		logged.length = 0;
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		const recorded = (await loadState(projectDir))?.processes ?? {};
		await stopRecordedProcesses(recorded, realSignalFns, { graceMs: 100 });
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("rejects naming the component and its probe, leaves the process running, and records its pid", async () => {
		writeFileSync(join(projectDir, "Launchfile"), NEVER_HEALTHY);

		const err = await launchUp({ projectDir }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(
			/component\(s\) default \(GET http:\/\/localhost:\d+\/healthz\) did not become healthy within 60s/,
		);
		// Tagged with the phase so the CLI records the deployment as unhealthy.
		expect(isLaunchError(err)).toBe(true);
		if (isLaunchError(err)) {
			expect(err.context.phase).toBe("health");
			expect(err.context.provider).toBe("macos-dev");
			expect(err.context.app).toBe("app");
		}

		expect(logged.join("\n")).not.toContain("All components started");

		const recorded = (await loadState(projectDir))?.processes ?? {};
		expect(Object.keys(recorded)).toEqual(["default"]);
		expect(alive(recorded.default?.pid ?? -1)).toBe(true);

		// What `down` runs reaches the recorded process.
		const outcomes = await stopRecordedProcesses(recorded, realSignalFns, { graceMs: 100 });
		expect(outcomes).toEqual([expect.objectContaining({ component: "default", result: "stopped" })]);
		expect(alive(recorded.default?.pid ?? -1)).toBe(false);
	});

	it("still resolves for a component that declares no health check", async () => {
		writeFileSync(join(projectDir, "Launchfile"), NO_HEALTH);

		await expect(launchUp({ projectDir })).resolves.toBeUndefined();
		expect(logged.join("\n")).toContain("All components started");
	});
});
