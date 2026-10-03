/**
 * `launch up` saves each SQL resource's record to state.json before the
 * provisioner creates its role, so a throw later in the same `up` — here, the
 * next resource failing — leaves the password the role was created with on
 * disk for the next `up` to reuse.
 *
 * The mock set mirrors resource-uses-up.test.ts: no subprocess, no pm2. The
 * real postgres provisioner runs against the mocked shell; redis is replaced
 * by a provisioner that throws.
 */

import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shellCommands: string[] = [];

vi.mock("../prereqs.js", () => ({
	checkPrereqs: async () => ({ ok: true, missing: [] }),
}));

vi.mock("../runtimes/index.js", () => ({
	getRuntimeInstaller: () => undefined,
}));

vi.mock("../shell.js", () => ({
	shell: async (cmd: string, args: string[]) => {
		shellCommands.push([cmd, ...args].join(" "));
		return { exitCode: 0, stdout: "", stderr: "" };
	},
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

vi.mock("../resources/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../resources/index.js")>();
	return {
		...actual,
		getProvisioner: (type: string) =>
			type === "redis"
				? {
						type: "redis",
						isRunning: async () => true,
						provision: async () => {
							throw new Error("redis failed to start");
						},
						destroy: async () => {},
					}
				: actual.getProvisioner(type),
	};
});

const { launchUp } = await import("../provider.js");

const LAUNCHFILE = `
name: app
runtime: node
commands: { start: "node web.js" }
requires:
  - type: postgres
    set_env:
      DATABASE_URL: $url
  - type: redis
    set_env:
      REDIS_URL: $url
`;

describe("macos-dev up — a SQL resource's password survives a later throw", () => {
	let projectDir: string;

	beforeEach(() => {
		shellCommands.length = 0;
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-persist-up-"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`__exit__${code}`);
		}) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("leaves the postgres password the role was created with in state.json", async () => {
		writeFileSync(join(projectDir, "Launchfile"), LAUNCHFILE);

		await expect(launchUp({ projectDir })).rejects.toThrow(
			/redis failed to start/,
		);

		const statePath = join(projectDir, ".launchfile", "state.json");
		const saved = JSON.parse(readFileSync(statePath, "utf8"));
		const password = saved.resources?.postgres?.password;
		expect(typeof password).toBe("string");
		expect(password.length).toBeGreaterThan(0);
		const createRole = shellCommands.find((c) => c.includes("CREATE ROLE"));
		expect(createRole).toContain(`PASSWORD '${password}'`);
		// D-18: the file holding the password is owner-only.
		expect(statSync(statePath).mode & 0o777).toBe(0o600);
	});
});
