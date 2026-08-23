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
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let launchfile = "";

const releaseEnvs: (Record<string, string> | undefined)[] = [];
const startRegistrations: { name: string; env: Record<string, string> }[] = [];
const provisioned: string[] = [];
const writtenEnvFiles: { path: string; env: Record<string, string> }[] = [];

vi.mock("node:fs/promises", () => ({
	readFile: async () => launchfile,
	writeFile: async () => {},
	mkdir: async () => {},
}));

vi.mock("../prereqs.js", () => ({
	checkPrereqs: async () => ({ ok: true, missing: [] }),
}));

vi.mock("../state.js", () => ({
	loadState: async () => null,
	initState: (appName: string) => ({
		version: 1,
		appName,
		launchfileHash: "test",
		resources: {},
		ports: {},
		secrets: {},
		processes: {},
	}),
	saveState: async () => {},
	ensureDirs: async () => {},
}));

vi.mock("../port-allocator.js", () => ({
	allocatePorts: async () => ({ default: 3000 }),
}));

vi.mock("../resources/index.js", () => ({
	getProvisioner: (type: string) =>
		type === "postgres"
			? {
					provision: async () => {
						provisioned.push(type);
						return {
							properties: { url: "postgresql://u:p@localhost:5432/app", host: "localhost", port: 5432 },
							state: { type, name: type, port: 5432 },
						};
					},
					isRunning: async () => true,
				}
			: undefined,
}));

vi.mock("../runtimes/index.js", () => ({
	getRuntimeInstaller: () => undefined,
}));

vi.mock("../lockfile-detect.js", () => ({
	detectPackageManager: async () => undefined,
}));

vi.mock("../storage.js", () => ({
	provisionStorage: async () => ({}),
	storagePaths: () => ({}),
}));

vi.mock("../shell.js", () => ({
	shell: async (_cmd: string, opts?: { env?: Record<string, string> }) => {
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

vi.mock("../env-writer.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		writeEnvFile: async (path: string, env: Record<string, string>) => {
			writtenEnvFiles.push({ path, env });
		},
	};
});

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

describe("macos-dev up/env — unsupplied required env (rule 8, D-52)", () => {
	let exitCode: number | undefined;

	beforeEach(() => {
		releaseEnvs.length = 0;
		startRegistrations.length = 0;
		provisioned.length = 0;
		writtenEnvFiles.length = 0;
		exitCode = undefined;
		delete process.env.SITE_URL;
		delete process.env.ADMIN_TOKEN;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCode = code;
			throw new Error(`__exit__${code}`);
		}) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.SITE_URL;
		delete process.env.ADMIN_TOKEN;
	});

	const stderr = () => vi.mocked(console.error).mock.calls.flat().join("\n");
	const stdout = () => vi.mocked(console.log).mock.calls.flat().join("\n");

	// 14
	it("up fails naming the component and the variable", async () => {
		launchfile = RELEASE_AND_START;
		await expect(launchUp({ projectDir: "/tmp/x" })).rejects.toThrow("__exit__1");
		expect(exitCode).toBe(1);
		expect(stderr()).toContain("default: SITE_URL");
	});

	it("up marks a sensitive variable without printing any value", async () => {
		launchfile = SENSITIVE;
		await expect(launchUp({ projectDir: "/tmp/x" })).rejects.toThrow("__exit__1");
		expect(stderr()).toContain("ADMIN_TOKEN (sensitive)");
	});

	it("up fails before provisioning or starting anything", async () => {
		launchfile = RELEASE_AND_START;
		await expect(launchUp({ projectDir: "/tmp/x" })).rejects.toThrow("__exit__1");
		expect(provisioned).toEqual([]);
		expect(startRegistrations).toEqual([]);
		expect(writtenEnvFiles).toEqual([]);
	});

	// 15
	it("an operator value in process.env reaches BOTH release's and start's env", async () => {
		launchfile = RELEASE_AND_START;
		process.env.SITE_URL = "https://wiki.example.com";

		await launchUp({ projectDir: "/tmp/x" });

		// `release` gets `allEnvs[name]` with no process.env inheritance, so it
		// only sees the value if the explicit channel put it there.
		expect(releaseEnvs.length).toBeGreaterThan(0);
		expect(releaseEnvs.at(-1)?.SITE_URL).toBe("https://wiki.example.com");
		expect(startRegistrations[0]?.env.SITE_URL).toBe("https://wiki.example.com");
		// And it reaches the written .env file, which is what makes it visible.
		expect(writtenEnvFiles[0]?.env.SITE_URL).toBe("https://wiki.example.com");
	});

	it("does not fail once the operator supplies the value", async () => {
		launchfile = SENSITIVE;
		process.env.ADMIN_TOKEN = "s3cret";
		await expect(launchUp({ projectDir: "/tmp/x" })).resolves.toBeUndefined();
		expect(exitCode).toBeUndefined();
	});

	// 16
	describe("env verb", () => {
		beforeEach(async () => {
			const state = await import("../state.js");
			vi.spyOn(state, "loadState").mockResolvedValue({
				version: 1,
				appName: "app",
				launchfileHash: "test",
				resources: {},
				ports: { default: 3000 },
				secrets: {},
				processes: {},
			} as never);
		});

		it("reports the unsupplied var as a comment, never as a bare KEY= line", async () => {
			launchfile = SENSITIVE;
			await launchEnv({ projectDir: "/tmp/x" });

			const out = stdout();
			expect(out).toContain("# ADMIN_TOKEN: unsupplied");
			expect(out).toContain("sensitive");
			// stdout stays `eval`-able: no bare export of an empty value.
			expect(out).not.toMatch(/^ADMIN_TOKEN=/m);
		});

		it("every non-comment line stays a valid KEY=VALUE assignment", async () => {
			launchfile = SENSITIVE;
			await launchEnv({ projectDir: "/tmp/x" });

			const lines = stdout()
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0 && !l.startsWith("#"));
			for (const line of lines) {
				expect(line).toMatch(/^[A-Za-z_][A-Za-z0-9_]*=.*/);
			}
		});

		it("prints a real value instead of the report once the operator supplies it", async () => {
			launchfile = SENSITIVE;
			process.env.ADMIN_TOKEN = "s3cret";
			await launchEnv({ projectDir: "/tmp/x" });

			const out = stdout();
			expect(out).toMatch(/^ADMIN_TOKEN=s3cret$/m);
			expect(out).not.toContain("# ADMIN_TOKEN: unsupplied");
		});
	});
});
