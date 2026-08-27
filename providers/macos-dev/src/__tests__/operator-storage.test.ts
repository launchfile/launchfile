/**
 * `storage.<name>.content: operator` in this provider (D-50).
 *
 * This provider runs processes on the host, so a volume is a directory path
 * injected as `$storage.<name>.path` (D-39) rather than a mount. Binding the
 * operator's content therefore means naming their directory, and the row-3
 * obligation — never create it — is what these tests pin: a passing refusal
 * message with an empty `~/Music` minted underneath it is the exact failure
 * D-50 was ratified to close, and only a filesystem assertion catches that.
 *
 * The mock set mirrors provider-required-env.test.ts, and for the same reason:
 * real subprocess exec and a real pm2 registration have no place in a unit
 * test, while `storage.js`, `state.js` and `port-allocator.js` run for real
 * against a temp project directory. `node:fs`'s `existsSync`/`accessSync` are
 * deliberately NOT mocked — the refusals are about what is actually on disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionStorage, storagePaths } from "../storage.js";

const shellCalls: string[] = [];
const startRegistrations: { name: string; env: Record<string, string> }[] = [];
const writtenEnvFiles: { path: string; content: string }[] = [];
const consoleLogs: string[] = [];
const consoleWarns: string[] = [];
const consoleErrors: string[] = [];

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
	shell: async (cmd: string) => {
		shellCalls.push(cmd);
		return { exitCode: 0, stdout: "", stderr: "" };
	},
	shellOk: async () => true,
	shellScript: async (command: string) => {
		shellCalls.push(command);
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

const { launchEnv, launchUp } = await import("../provider.js");

/** One marked volume, one unmarked, and the marked path injected as env. */
const MARKED = `
name: app
runtime: node
storage:
  media: { path: /media, content: operator }
  cache: { path: /cache }
env:
  MEDIA_DIR: $storage.media.path
commands:
  start: "node server.js"
`;

// Two components declaring a same-named `media` volume — the ambiguous case.
const TWO_COMPONENTS = `
name: app
components:
  web:
    runtime: node
    storage:
      media: { path: /media, content: operator }
    commands: { start: "node web.js" }
  worker:
    runtime: node
    storage:
      media: { path: /media, content: operator }
    commands: { start: "node worker.js" }
`;

describe("storagePaths / provisionStorage — content: operator (D-50)", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-d50-unit-"));
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	const STORAGE = {
		media: { path: "/media", content: "operator" as const },
		cache: { path: "/cache" },
	};

	it("names the operator's directory as the volume path (row 1)", () => {
		const paths = storagePaths(STORAGE, "default", projectDir, { media: "/srv/library" });
		expect(paths.media).toBe("/srv/library");
	});

	it("leaves a marked volume out of the map when nothing was supplied (row 2)", () => {
		const paths = storagePaths(STORAGE, "default", projectDir);
		expect(paths.media).toBeUndefined();
	});

	it("keeps an unmarked volume on its provider-owned path (row 4)", () => {
		const paths = storagePaths(STORAGE, "default", projectDir, { media: "/srv/library" });
		expect(paths.cache).toBe(join(projectDir, ".launchfile", "storage", "default", "cache"));
	});

	it("never creates the operator's directory, and still creates the unmarked one", async () => {
		const library = join(projectDir, "library");
		mkdirSync(library);
		rmSync(library, { recursive: true });

		await provisionStorage(STORAGE, "default", projectDir, { media: library });

		expect(existsSync(library)).toBe(false);
		expect(existsSync(join(projectDir, ".launchfile", "storage", "default", "cache"))).toBe(true);
	});
});

describe("macos-dev up — operator storage (D-50 rule 2)", () => {
	let projectDir: string;
	let library: string;
	let exitCode: number | undefined;

	beforeEach(() => {
		shellCalls.length = 0;
		startRegistrations.length = 0;
		writtenEnvFiles.length = 0;
		consoleLogs.length = 0;
		consoleWarns.length = 0;
		consoleErrors.length = 0;
		exitCode = undefined;
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-d50-up-"));
		library = join(projectDir, "library");
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
	});

	const writeLaunchfile = (yaml: string) => writeFileSync(join(projectDir, "Launchfile"), yaml);
	const providerOwned = (component: string, volume: string) =>
		join(projectDir, ".launchfile", "storage", component, volume);

	it("refuses a marked volume with no supplied path, naming the flag (row 2)", async () => {
		writeLaunchfile(MARKED);
		await expect(launchUp({ projectDir })).rejects.toThrow(
			"  - default: media — supply it with --storage media=<path>",
		);
	});

	it("spells the refusal flag `component.volume` when the name is ambiguous", async () => {
		writeLaunchfile(TWO_COMPONENTS);
		await expect(launchUp({ projectDir })).rejects.toThrow(
			"--storage web.media=<path>",
		);
	});

	it("refuses before provisioning, starting, or writing anything (row 2)", async () => {
		writeLaunchfile(MARKED);
		await expect(launchUp({ projectDir })).rejects.toThrow("content: operator");
		expect(shellCalls).toEqual([]);
		expect(startRegistrations).toEqual([]);
		expect(writtenEnvFiles).toEqual([]);
		// Not even the unmarked volume's directory — the refusal lands first.
		expect(existsSync(join(projectDir, ".launchfile", "storage"))).toBe(false);
		expect(exitCode).toBeUndefined();
	});

	it("refuses under --dry-run too — a dry run must not report a launch it would refuse", async () => {
		writeLaunchfile(MARKED);
		await expect(launchUp({ projectDir, dryRun: true })).rejects.toThrow("content: operator");
		expect(existsSync(join(projectDir, ".launchfile", "storage"))).toBe(false);
	});

	it("refuses a supplied path that is not on disk, and does not create it (row 3)", async () => {
		writeLaunchfile(MARKED);
		await expect(launchUp({ projectDir, storage: { media: library } })).rejects.toThrow(
			"does not exist or is not readable",
		);
		expect(existsSync(library)).toBe(false);
	});

	it("echoes the supplied key as the operator typed it in the row-3 refusal", async () => {
		writeLaunchfile(MARKED);
		await expect(launchUp({ projectDir, storage: { media: library } })).rejects.toThrow(
			`--storage media=${library}`,
		);
	});

	it("binds a supplied directory and injects it as $storage.<name>.path (row 1)", async () => {
		writeLaunchfile(MARKED);
		mkdirSync(library);

		await launchUp({ projectDir, storage: { media: library } });

		const envFile = writtenEnvFiles.find((f) => f.path.endsWith(".env.local"));
		expect(envFile?.content).toContain(`MEDIA_DIR=${library}`);
		expect(startRegistrations[0]?.env.MEDIA_DIR).toBe(library);
	});

	it("resolves a relative supplied path against the current directory", async () => {
		writeLaunchfile(MARKED);
		mkdirSync(library);
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(projectDir);

		await launchUp({ projectDir, storage: { media: "library" } });

		cwd.mockRestore();
		expect(startRegistrations[0]?.env.MEDIA_DIR).toBe(library);
	});

	it("still creates the unmarked volume's own directory (row 4)", async () => {
		writeLaunchfile(MARKED);
		mkdirSync(library);

		await launchUp({ projectDir, storage: { media: library } });

		expect(existsSync(providerOwned("default", "cache"))).toBe(true);
		expect(existsSync(providerOwned("default", "media"))).toBe(false);
	});

	it("warns about a supplied key that bound nothing", async () => {
		writeLaunchfile(MARKED);
		mkdirSync(library);

		await launchUp({ projectDir, storage: { media: library, typo: library } });

		expect(consoleWarns.join("\n")).toContain(
			"--storage typo matches no `content: operator` volume — ignored",
		);
	});

	it("warns about a key naming an unmarked volume — row 4 leaves those alone", async () => {
		writeLaunchfile(MARKED);
		mkdirSync(library);

		await launchUp({ projectDir, storage: { media: library, cache: library } });

		expect(consoleWarns.join("\n")).toContain("--storage cache matches no");
		expect(existsSync(providerOwned("default", "cache"))).toBe(true);
	});

	it("reports the bound path from `env`, not the provider-owned one", async () => {
		writeLaunchfile(MARKED);
		mkdirSync(library);
		await launchUp({ projectDir, storage: { media: library } });

		consoleLogs.length = 0;
		await launchEnv({ projectDir });

		expect(consoleLogs.join("\n")).toContain(`MEDIA_DIR=${library}`);
	});
});
