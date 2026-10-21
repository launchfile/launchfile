/**
 * `launch up` against a repository that ships a symlink where this provider
 * writes (#655): `.launchfile/`, `.launchfile/env`, `.launchfile/state.json`
 * or `.env.local`. Each is refused before anything goes through the link,
 * the run exits 1 naming the path, and the link's target is untouched. A
 * project that merely sits under a symlinked parent is not refused.
 *
 * The mock set mirrors sqlite-refused-up.test.ts: no subprocess, no process
 * manager. Every write site runs for real against a real temp project.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const SINGLE = `
name: app
components:
  default:
    runtime: node
    commands: { start: "node server.js" }
`;

const MULTI = `
name: app
components:
  web:
    runtime: node
    commands: { start: "node web.js" }
  worker:
    runtime: node
    commands: { start: "node worker.js" }
`;

describe("macos-dev up — a symlink where the provider writes (#655)", () => {
	let projectDir: string;
	let victimDir: string;
	let exitCode: number | undefined;

	beforeEach(() => {
		consoleErrors.length = 0;
		exitCode = undefined;
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-confined-"));
		victimDir = mkdtempSync(join(tmpdir(), "lf-macos-confined-victim-"));
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
		rmSync(victimDir, { recursive: true, force: true });
	});

	const writeLaunchfile = (yaml: string) =>
		writeFileSync(join(projectDir, "Launchfile"), yaml);

	/** The one `Refused:` line `up` printed, which must carry no stack trace. */
	function refusal(): string {
		const lines = consoleErrors.filter((l) => l.startsWith("Refused: "));
		expect(lines).toHaveLength(1);
		expect(consoleErrors.join("\n")).not.toMatch(/^\s+at /m);
		return lines[0] ?? "";
	}

	it("refuses a .launchfile symlink before writing anything, and exits 1", async () => {
		writeLaunchfile(SINGLE);
		symlinkSync(victimDir, join(projectDir, ".launchfile"));

		await expect(launchUp({ projectDir })).rejects.toThrow("__exit__1");

		expect(exitCode).toBe(1);
		expect(refusal()).toBe(
			`Refused: ${join(realpathSync(projectDir), ".launchfile")} is a symlink to ${victimDir}; refusing to write`,
		);
		// Nothing reached the target, and nothing else was written either:
		// the first write `up` makes is the one that refused.
		expect(readdirSync(victimDir)).toEqual([]);
		expect(readdirSync(projectDir).sort()).toEqual([
			".launchfile",
			"Launchfile",
		]);
	});

	it("refuses a .launchfile/env symlink before any env file or state is written", async () => {
		writeLaunchfile(MULTI);
		mkdirSync(join(projectDir, ".launchfile"));
		symlinkSync(victimDir, join(projectDir, ".launchfile", "env"));

		await expect(launchUp({ projectDir })).rejects.toThrow("__exit__1");

		expect(exitCode).toBe(1);
		expect(refusal()).toContain(
			`${join(".launchfile", "env")} is a symlink to ${victimDir}; refusing to write`,
		);
		expect(readdirSync(victimDir)).toEqual([]);
		expect(existsSync(join(projectDir, ".launchfile", "state.json"))).toBe(
			false,
		);
	});

	it("refuses a state.json symlink and leaves the file it points at untouched", async () => {
		writeLaunchfile(SINGLE);
		const victim = join(victimDir, "sink");
		writeFileSync(victim, "untouched\n");
		mkdirSync(join(projectDir, ".launchfile"));
		symlinkSync(victim, join(projectDir, ".launchfile", "state.json"));

		await expect(launchUp({ projectDir })).rejects.toThrow("__exit__1");

		expect(exitCode).toBe(1);
		expect(refusal()).toContain(
			`${join(".launchfile", "state.json")} is a symlink to ${victim}; refusing to write`,
		);
		expect(readFileSync(victim, "utf8")).toBe("untouched\n");
	});

	it("refuses an .env.local symlink and leaves the file it points at untouched", async () => {
		writeLaunchfile(SINGLE);
		const victim = join(victimDir, "sink");
		writeFileSync(victim, "untouched\n");
		symlinkSync(victim, join(projectDir, ".env.local"));

		await expect(launchUp({ projectDir })).rejects.toThrow("__exit__1");

		expect(exitCode).toBe(1);
		expect(refusal()).toContain(
			`.env.local is a symlink to ${victim}; refusing to write`,
		);
		expect(readFileSync(victim, "utf8")).toBe("untouched\n");
		expect(existsSync(join(projectDir, ".launchfile", "state.json"))).toBe(
			false,
		);
	});

	it("allows a project directory reached through a symlinked parent", async () => {
		// The confinement is about links inside the project, not above it:
		// /tmp itself is a symlink on macOS, and a project behind one is fine.
		writeLaunchfile(SINGLE);
		const linkedParent = join(victimDir, "link");
		symlinkSync(projectDir, linkedParent);

		await expect(
			launchUp({ projectDir: linkedParent }),
		).resolves.toBeUndefined();

		expect(exitCode).toBeUndefined();
		expect(consoleErrors.filter((l) => l.startsWith("Refused"))).toEqual([]);
		expect(existsSync(join(projectDir, ".launchfile", "state.json"))).toBe(
			true,
		);
		expect(existsSync(join(projectDir, ".env.local"))).toBe(true);
	});
});
