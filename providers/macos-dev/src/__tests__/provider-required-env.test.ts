/**
 * The `up` and `env` branches of PROVIDERS.md §10 rule 8 in this provider (D-52).
 *
 * `up` must fail by name before it provisions anything, and its operator channel
 * — the launching environment — must be read EXPLICITLY, so the value reaches
 * `release` as well as `start` and shows up in `env`. Before this change the
 * only way a value arrived was the `...process.env` spread on the pm2
 * registration, which `release` never saw and `env` could not print.
 *
 * `env` must report an unsupplied var without emitting a bare `KEY=` line: its
 * output is designed to be `eval`'d, and an empty export re-creates the exact
 * failure the rule exists to stop.
 *
 * Only `shell.js` and `process-manager.js` are mocked — real subprocess exec
 * and a real pm2 registration have no place in a unit test. Every other
 * collaborator (`state.js`, `resources/index.js`, `port-allocator.js`,
 * `lockfile-detect.js`, `storage.js`) runs for real against a real temp
 * project directory: they're also driven for real by their own dedicated
 * test files (state.test.ts, dry-run.test.ts, ...), and `provider.js` is a
 * process-wide singleton — a module mocked here for this file's `launchUp`
 * call is mocked for every other file's calls into that same module too.
 * `resources/index.js`'s Postgres provisioner takes its shell dependency by
 * injection (see postgres.ts's `ShellRunner`), defaulting to the already-
 * mocked `./shell.js` — so running it for real never touches a live
 * Homebrew/Postgres install.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shellCalls: string[] = [];
const releaseEnvs: (Record<string, string> | undefined)[] = [];
const startRegistrations: { name: string; env: Record<string, string> }[] = [];
const writtenEnvFiles: { path: string; content: string }[] = [];
const consoleLogs: string[] = [];
const consoleErrors: string[] = [];

// Real reads/writes/mkdir, confined to whatever path the caller passes —
// every test below points collaborators at its own temp project dir.
// `writeFile` is additionally captured so assertions can inspect what was
// written without re-reading the file back off disk.
vi.mock("node:fs/promises", () => ({
	readFile: async (path: string, encoding?: BufferEncoding) =>
		readFileSync(path, encoding ?? "utf8"),
	writeFile: async (path: string, content: string, opts?: { mode?: number }) => {
		writtenEnvFiles.push({ path: String(path), content: String(content) });
		writeFileSync(path, content, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
	},
	mkdir: async (path: string, opts?: { recursive?: boolean; mode?: number }) => {
		mkdirSync(path, opts);
	},
}));

vi.mock("../prereqs.js", () => ({
	checkPrereqs: async () => ({ ok: true, missing: [] }),
}));

vi.mock("../runtimes/index.js", () => ({
	getRuntimeInstaller: () => undefined,
}));

vi.mock("../shell.js", () => ({
	shell: async (cmd: string, _args: string[], opts?: { env?: Record<string, string> }) => {
		shellCalls.push(cmd);
		releaseEnvs.push(opts?.env);
		return { exitCode: 0, stdout: "", stderr: "" };
	},
	shellOk: async () => true,
	shellScript: async (command: string, opts?: { env?: Record<string, string> }) => {
		shellCalls.push(command);
		releaseEnvs.push(opts?.env);
		return { exitCode: 0, stdout: "", stderr: "" };
	},
}));

vi.mock("../process-manager.js", () => ({
	ProcessManager: class {
		register(name: string, opts: { env: Record<string, string> }) {
			startRegistrations.push({ name, env: opts.env });
		}
		async startAll() {}
		async stopAll() {}
		getRecordedProcesses() {
			return {};
		}
	},
}));

const { launchUp, launchEnv } = await import("../provider.js");

const RELEASE_AND_START = `
name: app
runtime: node
requires:
  - type: postgres
    set_env:
      DATABASE_URL: $url
env:
  SITE_URL:
    required: true
commands:
  release: "node migrate.js"
  start: "node server.js"
`;

const SENSITIVE = `
name: app
runtime: node
env:
  ADMIN_TOKEN:
    required: true
    sensitive: true
commands:
  start: "node server.js"
`;

let projectDir: string;

function writeLaunchfile(yaml: string): void {
	writeFileSync(join(projectDir, "Launchfile"), yaml);
}

describe("macos-dev up/env — unsupplied required env (rule 8, D-52)", () => {
	let exitCode: number | undefined;

	beforeEach(() => {
		shellCalls.length = 0;
		releaseEnvs.length = 0;
		startRegistrations.length = 0;
		writtenEnvFiles.length = 0;
		consoleLogs.length = 0;
		consoleErrors.length = 0;
		exitCode = undefined;
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-required-env-"));
		delete process.env.SITE_URL;
		delete process.env.ADMIN_TOKEN;
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			consoleLogs.push(args.map(String).join(" "));
		});
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
		delete process.env.SITE_URL;
		delete process.env.ADMIN_TOKEN;
	});

	const stderr = () => consoleErrors.join("\n");
	const stdout = () => consoleLogs.join("\n");

	// 14
	it("up fails naming the component and the variable", async () => {
		writeLaunchfile(RELEASE_AND_START);
		await expect(launchUp({ projectDir })).rejects.toThrow("__exit__1");
		expect(exitCode).toBe(1);
		expect(stderr()).toContain("default: SITE_URL");
	});

	it("up marks a sensitive variable without printing any value", async () => {
		writeLaunchfile(SENSITIVE);
		await expect(launchUp({ projectDir })).rejects.toThrow("__exit__1");
		expect(stderr()).toContain("ADMIN_TOKEN (sensitive)");
	});

	it("up fails before provisioning or starting anything", async () => {
		writeLaunchfile(RELEASE_AND_START);
		await expect(launchUp({ projectDir })).rejects.toThrow("__exit__1");
		// No provisioning shell call (pg_isready, psql, createdb, ...) ran.
		expect(shellCalls).toEqual([]);
		expect(startRegistrations).toEqual([]);
		expect(writtenEnvFiles).toEqual([]);
	});

	// 15
	it("an operator value in process.env reaches BOTH release's and start's env", async () => {
		writeLaunchfile(RELEASE_AND_START);
		process.env.SITE_URL = "https://wiki.example.com";

		await launchUp({ projectDir });

		// `release` gets `allEnvs[name]` with no process.env inheritance, so it
		// only sees the value if the explicit channel put it there.
		expect(releaseEnvs.length).toBeGreaterThan(0);
		expect(releaseEnvs.at(-1)?.SITE_URL).toBe("https://wiki.example.com");
		expect(startRegistrations[0]?.env.SITE_URL).toBe("https://wiki.example.com");
		// And it reaches the written .env file, which is what makes it visible.
		// (saveState also writes state.json and a .gitignore alongside it.)
		expect(
			writtenEnvFiles.some((f) => /^SITE_URL=https:\/\/wiki\.example\.com$/m.test(f.content)),
		).toBe(true);
	});

	it("does not fail once the operator supplies the value", async () => {
		writeLaunchfile(SENSITIVE);
		process.env.ADMIN_TOKEN = "s3cret";
		await expect(launchUp({ projectDir })).resolves.toBeUndefined();
		expect(exitCode).toBeUndefined();
	});

	// 16
	describe("env verb", () => {
		beforeEach(async () => {
			// Real usage: `up` persists state once (with the value supplied), then
			// the operator's shell loses the value before `env` is run again.
			writeLaunchfile(SENSITIVE);
			process.env.ADMIN_TOKEN = "s3cret";
			await launchUp({ projectDir });
			delete process.env.ADMIN_TOKEN;
			// Isolate `launchEnv`'s own output from `up`'s setup-phase logging.
			consoleLogs.length = 0;
		});

		it("reports the unsupplied var as a comment, never as a bare KEY= line", async () => {
			await launchEnv({ projectDir });

			const out = stdout();
			expect(out).toContain("# ADMIN_TOKEN: unsupplied");
			expect(out).toContain("sensitive");
			// stdout stays `eval`-able: no bare export of an empty value.
			expect(out).not.toMatch(/^ADMIN_TOKEN=/m);
		});

		it("every non-comment line stays a valid KEY=VALUE assignment", async () => {
			await launchEnv({ projectDir });

			const lines = stdout()
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0 && !l.startsWith("#"));
			for (const line of lines) {
				expect(line).toMatch(/^[A-Za-z_][A-Za-z0-9_]*=.*/);
			}
		});

		it("prints a real value instead of the report once the operator supplies it", async () => {
			process.env.ADMIN_TOKEN = "s3cret";
			await launchEnv({ projectDir });

			const out = stdout();
			expect(out).toMatch(/^ADMIN_TOKEN=s3cret$/m);
			expect(out).not.toContain("# ADMIN_TOKEN: unsupplied");
		});
	});
});
