/**
 * SPEC.md § Failure semantics, run slot: a component that did not come up
 * fails the invocation. A process that exits non-zero before `startAll`
 * resolves has not come up (issue #526), whether or not it declares `health:`.
 *
 * Real processes, real polling, no mocks: every component is a `sh -c`
 * spawned through the real `ProcessManager`. The watch window and the gate
 * budget are injected small so the suite stays fast; the defaults are
 * documented in CLAUDE.md.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForHealthy } from "../health.js";
import {
	ComponentExitError,
	EXIT_WATCH_MS,
	exitFailureMessage,
	HEALTH_TIMEOUT_MS,
	HealthGateError,
	ProcessManager,
} from "../process-manager.js";

const WATCH_MS = 300;
const BUDGET_MS = 5_000;
const NEVER = { command: "exit 1", interval: "100ms", timeout: "1s" };

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

describe("ProcessManager exit gate (issue #526)", () => {
	let projectDir: string;
	let pm: ProcessManager;
	const errors: string[] = [];

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "launchfile-exit-"));
		pm = new ProcessManager(projectDir, {
			healthTimeoutMs: BUDGET_MS,
			exitWatchMs: WATCH_MS,
		});
		errors.length = 0;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});
	});

	afterEach(async () => {
		await pm.stopAll();
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("documents its watch window as a provider default", () => {
		expect(EXIT_WATCH_MS).toBe(2_000);
		expect(EXIT_WATCH_MS).toBeLessThan(HEALTH_TIMEOUT_MS);
	});

	it("fails startAll when a component without health: exits non-zero, naming it and the code", async () => {
		pm.register("web", { command: "exit 3", env: {}, cwd: projectDir });

		const err = await pm.startAll().catch((e: unknown) => e as Error);
		expect(err).toBeInstanceOf(ComponentExitError);
		expect((err as Error).message).toBe(
			exitFailureMessage([{ name: "web", exit: "exit code 3" }]),
		);
		expect(pm.getStatus().find((s) => s.name === "web")?.status).toBe("failed");
		expect(errors.join("\n")).toContain("No component is left running.");
	});

	it("names a signal death as the signal, not a code", async () => {
		pm.register("web", { command: 'kill -9 "$$"', env: {}, cwd: projectDir });

		await expect(pm.startAll()).rejects.toThrow(
			exitFailureMessage([{ name: "web", exit: "signal SIGKILL" }]),
		);
	});

	it("resolves for a component without health: that outlives the watch window", async () => {
		pm.register("web", { command: "sleep 30", env: {}, cwd: projectDir });

		const started = Date.now();
		await expect(pm.startAll()).resolves.toBeUndefined();
		expect(Date.now() - started).toBeGreaterThanOrEqual(WATCH_MS - 20);
		expect(alive(pidOf(pm, "web") ?? -1)).toBe(true);
	});

	it("tolerates a component that exits 0 inside the window", async () => {
		pm.register("oneshot", { command: "exit 0", env: {}, cwd: projectDir });

		await expect(pm.startAll()).resolves.toBeUndefined();
		expect(pm.getStatus().find((s) => s.name === "oneshot")?.status).toBe(
			"stopped",
		);
	});

	it("leaves the components that did start running, and says so", async () => {
		pm.register("db", { command: "sleep 30", env: {}, cwd: projectDir });
		pm.register("web", {
			command: "sleep 0.1; exit 1",
			env: {},
			cwd: projectDir,
		});

		await expect(pm.startAll()).rejects.toThrow(
			exitFailureMessage([{ name: "web", exit: "exit code 1" }]),
		);

		expect(alive(pidOf(pm, "db") ?? -1)).toBe(true);
		expect(alive(pidOf(pm, "web") ?? -1)).toBe(false);
		// Both spawned, so both are recorded: `down` reaches the live one and
		// reports the dead one as already gone.
		expect(Object.keys(pm.getRecordedProcesses()).sort()).toEqual([
			"db",
			"web",
		]);
		const printed = errors.join("\n");
		expect(printed).toContain("Still running: db");
		expect(printed).toContain("`launchfile down` stops them");
	});

	it("stops a health poll as soon as its process exits, well inside the budget", async () => {
		pm.register("web", {
			command: "sleep 0.2; exit 7",
			env: {},
			cwd: projectDir,
			health: NEVER,
			port: 3000,
		});

		const started = Date.now();
		const err = await pm.startAll().catch((e: unknown) => e as Error);
		expect(err).toBeInstanceOf(ComponentExitError);
		expect((err as Error).message).toBe(
			exitFailureMessage([{ name: "web", exit: "exit code 7" }]),
		);
		expect(Date.now() - started).toBeLessThan(BUDGET_MS);
		expect(errors.join("\n")).toContain(
			"[web] Process exited before its health check passed",
		);
	});

	it("reports an exit over a stuck sibling: the exit is terminal, the check may still pass", async () => {
		const smallBudget = new ProcessManager(projectDir, {
			healthTimeoutMs: 300,
			exitWatchMs: WATCH_MS,
		});
		smallBudget.register("web", {
			command: "sleep 30",
			env: {},
			cwd: projectDir,
			health: NEVER,
			port: 3000,
		});
		smallBudget.register("worker", {
			command: "exit 2",
			env: {},
			cwd: projectDir,
		});
		try {
			const err = await smallBudget
				.startAll()
				.catch((e: unknown) => e as Error);
			expect(err).toBeInstanceOf(ComponentExitError);
			expect((err as Error).message).toBe(
				exitFailureMessage([{ name: "worker", exit: "exit code 2" }]),
			);
		} finally {
			await smallBudget.stopAll();
		}
	});

	it("still fails a check that never passes on a process that stays alive", async () => {
		const smallBudget = new ProcessManager(projectDir, {
			healthTimeoutMs: 300,
			exitWatchMs: WATCH_MS,
		});
		smallBudget.register("web", {
			command: "sleep 30",
			env: {},
			cwd: projectDir,
			health: NEVER,
			port: 3000,
		});
		try {
			const err = await smallBudget
				.startAll()
				.catch((e: unknown) => e as Error);
			expect(err).toBeInstanceOf(HealthGateError);
			expect((err as Error).message).toContain("did not become healthy: web");
		} finally {
			await smallBudget.stopAll();
		}
	});

	it("fails a health: component that exits 0 before its check passes", async () => {
		pm.register("api", {
			command: "sleep 0.2; exit 0",
			env: {},
			cwd: projectDir,
			health: NEVER,
			port: 3000,
		});

		const err = await pm.startAll().catch((e: unknown) => e as Error);
		expect(err).toBeInstanceOf(ComponentExitError);
		expect((err as Error).message).toBe(
			exitFailureMessage([{ name: "api", exit: "exit code 0" }]),
		);
		expect(pm.getStatus().find((s) => s.name === "api")?.status).toBe(
			"stopped",
		);
	});

	it("fails a condition: healthy gate whose target exits, naming the exit, and never starts the dependent", async () => {
		pm.register("api", {
			command: "sleep 0.1; exit 4",
			env: {},
			cwd: projectDir,
			health: NEVER,
			port: 3000,
		});
		pm.register("web", {
			command: "sleep 30",
			env: {},
			cwd: projectDir,
			dependsOn: [{ component: "api", condition: "healthy" }],
		});

		await expect(pm.startAll()).rejects.toThrow(
			`${exitFailureMessage([{ name: "api", exit: "exit code 4" }])}; web was not started`,
		);
		expect(pidOf(pm, "web")).toBeUndefined();
	});
});

describe("waitForHealthy with an exit signal", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns false at once when the signal is already aborted", async () => {
		const exited = new AbortController();
		exited.abort();
		await expect(
			waitForHealthy("web", NEVER, 0, 5_000, exited.signal),
		).resolves.toBe(false);
	});

	it("returns false as soon as the signal aborts mid-poll", async () => {
		const exited = new AbortController();
		const started = Date.now();
		const poll = waitForHealthy(
			"web",
			{ ...NEVER, interval: "2s", start_period: "2s" },
			0,
			10_000,
			exited.signal,
		);
		setTimeout(() => exited.abort(), 100);
		await expect(poll).resolves.toBe(false);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("polls to the deadline when no signal is given", async () => {
		await expect(waitForHealthy("web", NEVER, 0, 250)).resolves.toBe(false);
	});
});
