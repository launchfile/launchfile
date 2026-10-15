/**
 * `launch up` when the sqlite provisioner refuses a symlinked data path
 * (#388). The refusal skips the resource so every other one still
 * provisions, then the run exits non-zero naming each refused resource —
 * once, however many components share it, since a refused name is
 * remembered the way a provisioned one is. Nothing is created at the
 * symlink's target, and no state is saved.
 *
 * The mock set mirrors resource-uses-up.test.ts: no subprocess, no pm2.
 * The sqlite provisioner runs for real against a real temp project.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const consoleLogs: string[] = [];
const consoleWarns: string[] = [];
const consoleErrors: string[] = [];

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

// Both components require the same sqlite resource; `worker` also requires
// a second one, so the refusal is seen from two components and two entries.
const SHARED_REQUIRED = `
name: app
components:
  web:
    runtime: node
    commands: { start: "node web.js" }
    requires:
      - type: sqlite
        name: primary
        set_env:
          DATABASE_URL: $url
  worker:
    runtime: node
    commands: { start: "node worker.js" }
    requires:
      - type: sqlite
        name: cache
        set_env:
          CACHE_URL: $url
      - type: sqlite
        name: primary
        set_env:
          DATABASE_URL: $url
`;

const SHARED_OPTIONAL = `
name: app
components:
  web:
    runtime: node
    commands: { start: "node web.js" }
    supports:
      - type: sqlite
        name: primary
        set_env:
          DATABASE_URL: $url
  worker:
    runtime: node
    commands: { start: "node worker.js" }
    supports:
      - type: sqlite
        name: primary
        set_env:
          DATABASE_URL: $url
`;

describe("macos-dev up — a refused sqlite data path (#388)", () => {
	let projectDir: string;
	let victimDir: string;
	let exitCode: number | undefined;

	beforeEach(() => {
		consoleLogs.length = 0;
		consoleWarns.length = 0;
		consoleErrors.length = 0;
		exitCode = undefined;
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-sqlite-refused-"));
		victimDir = mkdtempSync(join(tmpdir(), "lf-macos-sqlite-victim-"));
		mkdirSync(join(projectDir, ".launchfile", "data"), { recursive: true });
		symlinkSync(victimDir, join(projectDir, ".launchfile", "data", "sqlite"));
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			consoleLogs.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			consoleWarns.push(args.map(String).join(" "));
		});
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
		rmSync(victimDir, { recursive: true, force: true });
	});

	const refusals = () =>
		consoleWarns.filter((l) => l.includes("refusing to provision"));

	it("exits 1 naming each refused required resource once, however many components share it", async () => {
		writeFileSync(join(projectDir, "Launchfile"), SHARED_REQUIRED);

		await expect(launchUp({ projectDir })).rejects.toThrow("__exit__1");

		expect(exitCode).toBe(1);
		const final = consoleErrors.find((l) =>
			l.startsWith("Refused to provision"),
		);
		expect(final).toBeDefined();
		expect(final).toContain("required resources: primary (");
		expect(final).toContain("; cache (");
		expect(final?.match(/primary \(/g)).toHaveLength(1);
		expect(final?.match(/cache \(/g)).toHaveLength(1);
		// Each resource is tried once: the provisioner printed two reasons,
		// not one per requiring entry.
		expect(refusals()).toHaveLength(2);
	});

	it("creates nothing at the symlink's target and saves no state", async () => {
		writeFileSync(join(projectDir, "Launchfile"), SHARED_REQUIRED);

		await expect(launchUp({ projectDir })).rejects.toThrow("__exit__1");

		expect(readdirSync(victimDir)).toEqual([]);
		expect(existsSync(join(projectDir, ".launchfile", "state.json"))).toBe(
			false,
		);
	});

	it("skips a refused optional resource once and lets the run continue (D-8)", async () => {
		writeFileSync(join(projectDir, "Launchfile"), SHARED_OPTIONAL);

		await expect(
			launchUp({ projectDir, withOptional: true }),
		).resolves.toBeUndefined();

		expect(exitCode).toBeUndefined();
		expect(refusals()).toHaveLength(1);
		expect(consoleLogs.filter((l) => l === " skipped")).toHaveLength(1);
		expect(readdirSync(victimDir)).toEqual([]);
	});
});
