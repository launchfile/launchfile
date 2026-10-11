/**
 * `up --detach` (#597): the session returns once every component has started,
 * the components keep running, and their pids are recorded so `down` stops
 * them from another shell.
 *
 * The session-exit cases run the real `ProcessManager` in a throwaway `bun`
 * session that never calls `process.exit`, so the session ends only when
 * nothing holds its event loop — the same thing that decides whether the CLI
 * returns. The `launchUp` cases follow up-health-fails.test.ts: the real
 * provider against a temp project, with prereqs and shell commands stubbed.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const PROCESS_MANAGER = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"process-manager.ts",
);

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

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/** The session's exit code, or "running" when it has not exited by the deadline. */
function exitWithin(
	session: ReturnType<typeof spawn>,
	ms: number,
): Promise<number | null | "running"> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve("running"), ms);
		session.on("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

describe("ProcessManager.detach (#597)", () => {
	let projectDir: string;
	const strays: number[] = [];

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "launchfile-detach-"));
	});

	afterEach(() => {
		for (const pid of strays.splice(0)) killGroup(pid);
		rmSync(projectDir, { recursive: true, force: true });
	});

	function session(detach: boolean): ReturnType<typeof spawn> {
		const pidFile = join(projectDir, "pid");
		const script = join(projectDir, "session.ts");
		writeFileSync(
			script,
			[
				`import { writeFileSync } from "node:fs";`,
				`import { ProcessManager } from ${JSON.stringify(PROCESS_MANAGER)};`,
				// A short exit watch keeps `startAll` well inside the session deadlines below.
				`const pm = new ProcessManager(${JSON.stringify(projectDir)}, { exitWatchMs: 100 });`,
				`pm.register("web", { command: "sleep 30", env: {}, cwd: ${JSON.stringify(projectDir)} });`,
				`await pm.startAll();`,
				`writeFileSync(${JSON.stringify(pidFile)}, String(pm.getRecordedProcesses().web?.pid));`,
				detach ? `pm.detach();` : "",
			].join("\n"),
		);
		return spawn("bun", ["run", script], { stdio: "ignore", detached: true });
	}

	const recordedPid = (): number =>
		Number(readFileSync(join(projectDir, "pid"), "utf8"));

	it("lets the session exit on its own while the component keeps running", async () => {
		const s = session(true);
		const code = await exitWithin(s, 5000);
		const pid = recordedPid();
		strays.push(pid);

		expect(code).toBe(0);
		expect(alive(pid)).toBe(true);
	});

	it("keeps the session waiting on the component without it", async () => {
		const s = session(false);
		const code = await exitWithin(s, 2000);
		if (s.pid !== undefined) strays.push(s.pid);
		strays.push(recordedPid());

		expect(code).toBe("running");
	});
});

describe("launchUp with detach (#597)", () => {
	let projectDir: string;
	const logged: string[] = [];
	let sigintBefore: ReturnType<typeof process.listeners>;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "launchfile-up-detach-"));
		writeFileSync(join(projectDir, "Launchfile"), NO_HEALTH);
		logged.length = 0;
		sigintBefore = process.listeners("SIGINT");
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		for (const listener of process.listeners("SIGINT")) {
			if (!sigintBefore.includes(listener)) {
				process.removeListener("SIGINT", listener as NodeJS.SignalsListener);
			}
		}
		const recorded = (await loadState(projectDir))?.processes ?? {};
		await stopRecordedProcesses(recorded, realSignalFns, { graceMs: 100 });
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("records the pid, installs no Ctrl+C handler, and says how to stop it", async () => {
		await launchUp({ projectDir, detach: true });

		const recorded = (await loadState(projectDir))?.processes ?? {};
		expect(Object.keys(recorded)).toEqual(["default"]);
		expect(alive(recorded.default?.pid ?? -1)).toBe(true);
		expect(process.listeners("SIGINT")).toEqual(sigintBefore);

		const output = logged.join("\n");
		expect(output).toContain(
			"Running in the background. `launchfile down` stops it.",
		);
		expect(output).not.toContain("Press Ctrl+C");

		// What `down` runs, from any shell, reaches the recorded process.
		const outcomes = await stopRecordedProcesses(recorded, realSignalFns, {
			graceMs: 100,
		});
		expect(outcomes).toEqual([
			expect.objectContaining({ component: "default", result: "stopped" }),
		]);
		expect(alive(recorded.default?.pid ?? -1)).toBe(false);
	});

	it("stays in the foreground with a Ctrl+C handler without it", async () => {
		await launchUp({ projectDir });

		expect(process.listeners("SIGINT").length).toBe(sigintBefore.length + 1);
		expect(logged.join("\n")).toContain("Press Ctrl+C to stop all processes.");
	});
});
