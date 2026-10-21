/**
 * `launchUp` tightens every secret-bearing file and the env dir it writes
 * (#683, CWE-276): `.env.local` in the project root, `.launchfile/env/` and
 * the per-component env files inside it, and `state.json`.
 *
 * `writeFile`'s and `mkdir`'s `mode` options apply only on create, so a file
 * or dir left looser by an earlier version used to stay that way. The mock set
 * mirrors operator-storage.test.ts: real subprocess exec and a real pm2
 * registration have no place in a unit test, while `state.js`,
 * `env-writer.js`, `storage.js` and `port-allocator.js` run for real against
 * a temp project directory, and `node:fs/promises` is NOT mocked — the
 * assertions are about what is actually on disk.
 *
 * Loose modes are set with an explicit `chmod`, never through a `mode` option:
 * a strict umask on the runner masks that option and the test would pass
 * without testing anything (#410).
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
runtime: node
env:
  ADMIN_TOKEN: { default: hunter2 }
commands:
  start: "node server.js"
`;

const TWO_COMPONENTS = `
name: app
components:
  web:
    runtime: node
    env:
      WEB_SECRET: { default: hunter2 }
    commands: { start: "node web.js" }
  worker:
    runtime: node
    env:
      WORKER_SECRET: { default: hunter3 }
    commands: { start: "node worker.js" }
`;

const mode = (path: string) => statSync(path).mode & 0o777;

describe("macos-dev up — secret files and the env dir are tightened on overwrite (#683)", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-modes-"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	const writeLaunchfile = (yaml: string) => writeFileSync(join(projectDir, "Launchfile"), yaml);

	it("rewrites a 0o644 .env.local and state.json at 0o600", async () => {
		writeLaunchfile(SINGLE);
		const envFile = join(projectDir, ".env.local");
		const stateFile = join(projectDir, ".launchfile", "state.json");
		writeFileSync(envFile, "OLD=value\n");
		chmodSync(envFile, 0o644);
		mkdirSync(join(projectDir, ".launchfile"), { recursive: true });
		writeFileSync(stateFile, "{}\n");
		chmodSync(stateFile, 0o644);
		expect(mode(envFile)).toBe(0o644);
		expect(mode(stateFile)).toBe(0o644);

		await launchUp({ projectDir });

		expect(mode(envFile)).toBe(0o600);
		expect(mode(stateFile)).toBe(0o600);
	});

	it("rewrites a 0o755 .launchfile/env and its 0o644 component files at 0o700 / 0o600", async () => {
		writeLaunchfile(TWO_COMPONENTS);
		const envDir = join(projectDir, ".launchfile", "env");
		mkdirSync(envDir, { recursive: true });
		chmodSync(envDir, 0o755);
		writeFileSync(join(envDir, "web.env"), "OLD=1\n");
		chmodSync(join(envDir, "web.env"), 0o644);
		expect(mode(envDir)).toBe(0o755);
		expect(mode(join(envDir, "web.env"))).toBe(0o644);

		await launchUp({ projectDir });

		expect(mode(envDir)).toBe(0o700);
		expect(mode(join(envDir, "web.env"))).toBe(0o600);
		expect(mode(join(envDir, "worker.env"))).toBe(0o600);
	});
});
