/**
 * SPEC.md § Failure semantics: a component that never becomes healthy fails
 * the invocation. PROVIDERS.md §10 rule 10 makes that a conformance duty, and
 * the docker provider already honors it (issue #376 is the macos-dev gap).
 *
 * Real processes, real polling, no mocks: every component here is a `sleep`
 * spawned through the real `ProcessManager`, and every check is a real
 * `command` probe (`exit 1` never passes, `true` always does) or a `path`
 * probe against a port nothing listens on. The gate budget is injected small
 * so the suite stays fast; the default budget is documented in CLAUDE.md.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	HEALTH_TIMEOUT_MS,
	HealthGateError,
	ProcessManager,
	healthFailureMessage,
} from "../process-manager.js";

const NEVER = { command: "exit 1", interval: "100ms", timeout: "1s" };
const ALWAYS = { command: "true", interval: "100ms", timeout: "1s" };
const BUDGET_MS = 400;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function pidOf(pm: ProcessManager, name: string): number | undefined {
	return pm.getStatus().find((s) => s.name === name)?.pid;
}

describe("ProcessManager health gate (issue #376)", () => {
	let projectDir: string;
	let pm: ProcessManager;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "launchfile-health-"));
		pm = new ProcessManager(projectDir, { healthTimeoutMs: BUDGET_MS });
	});

	afterEach(async () => {
		await pm.stopAll();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("fails startAll when a component's own check never passes and nothing depends on it", async () => {
		pm.register("web", { command: "sleep 30", env: {}, cwd: projectDir, health: NEVER, port: 3000 });

		await expect(pm.startAll()).rejects.toThrow(
			healthFailureMessage([{ name: "web", check: "command `exit 1`" }], BUDGET_MS),
		);

		// Left running for inspection, and recorded so status/logs/down reach it.
		const pid = pidOf(pm, "web");
		expect(pid).toBeDefined();
		expect(alive(pid ?? -1)).toBe(true);
		expect(Object.keys(pm.getRecordedProcesses())).toEqual(["web"]);
	});

	it("names every stuck component, with the probe each was asked", async () => {
		pm.register("web", {
			command: "sleep 30",
			env: {},
			cwd: projectDir,
			health: { path: "/healthz", interval: "100ms", timeout: "1s" },
			port: 1, // nothing listens on port 1
		});
		pm.register("worker", { command: "sleep 30", env: {}, cwd: projectDir, health: NEVER, port: 3001 });
		pm.register("ok", { command: "sleep 30", env: {}, cwd: projectDir, health: ALWAYS, port: 3002 });

		const err = await pm.startAll().catch((e: unknown) => e as Error);
		expect(err).toBeInstanceOf(HealthGateError);
		const msg = (err as Error).message;
		expect(msg).toContain("web (GET http://localhost:1/healthz)");
		expect(msg).toContain("worker (command `exit 1`)");
		expect(msg).not.toContain("ok (");
		expect(msg).toContain(`within ${BUDGET_MS / 1000}s`);
	});

	it("fails a condition: healthy gate whose target never becomes healthy, and never starts the dependent", async () => {
		pm.register("api", { command: "sleep 30", env: {}, cwd: projectDir, health: NEVER, port: 3000 });
		pm.register("web", {
			command: "sleep 30",
			env: {},
			cwd: projectDir,
			dependsOn: [{ component: "api", condition: "healthy" }],
		});

		await expect(pm.startAll()).rejects.toThrow(
			`${healthFailureMessage([{ name: "api", check: "command `exit 1`" }], BUDGET_MS)}; web was not started`,
		);

		expect(alive(pidOf(pm, "api") ?? -1)).toBe(true);
		expect(pidOf(pm, "web")).toBeUndefined();
		expect(Object.keys(pm.getRecordedProcesses())).toEqual(["api"]);
	});

	it("fails closed when a condition: healthy target declares no health check", async () => {
		pm.register("api", { command: "sleep 30", env: {}, cwd: projectDir, port: 3000 });
		pm.register("web", {
			command: "sleep 30",
			env: {},
			cwd: projectDir,
			dependsOn: [{ component: "api", condition: "healthy" }],
		});

		await expect(pm.startAll()).rejects.toThrow(
			"component web depends on api with condition: healthy, but api declares no health check",
		);
		expect(pidOf(pm, "web")).toBeUndefined();
	});

	it("fails closed when a path check has no port to poll", async () => {
		pm.register("web", {
			command: "sleep 30",
			env: {},
			cwd: projectDir,
			health: { path: "/healthz", interval: "100ms" },
		});

		await expect(pm.startAll()).rejects.toThrow(
			"component web declares a health check (GET http://localhost:<unallocated>/healthz) but no port was allocated to poll",
		);
	});

	it("resolves when every declared check passes, and marks those components healthy", async () => {
		pm.register("api", { command: "sleep 30", env: {}, cwd: projectDir, health: ALWAYS, port: 3000 });
		pm.register("web", { command: "sleep 30", env: {}, cwd: projectDir, health: ALWAYS, port: 3001 });
		pm.register("worker", { command: "sleep 30", env: {}, cwd: projectDir });

		await expect(pm.startAll()).resolves.toBeUndefined();

		const byName = Object.fromEntries(pm.getStatus().map((s) => [s.name, s.status]));
		expect(byName).toEqual({ api: "healthy", web: "healthy", worker: "running" });
	});

	it("polls a dependency verified at its gate once, not again in the sweep", async () => {
		const counter = join(projectDir, "polls");
		writeFileSync(counter, "");
		pm.register("api", {
			command: "sleep 30",
			env: {},
			cwd: projectDir,
			health: { command: `echo poll >> "${counter}"`, interval: "100ms", timeout: "1s" },
			port: 3000,
		});
		pm.register("web", {
			command: "sleep 30",
			env: {},
			cwd: projectDir,
			dependsOn: [{ component: "api", condition: "healthy" }],
		});

		await expect(pm.startAll()).resolves.toBeUndefined();
		expect(readFileSync(counter, "utf8").trim().split("\n")).toEqual(["poll"]);
	});

	it("documents its default budget", () => {
		// CLAUDE.md's timeout table states 60s; PROVIDERS.md §10 rule 10 requires
		// the default to be documented, so the two must agree.
		expect(HEALTH_TIMEOUT_MS).toBe(60_000);
	});
});
