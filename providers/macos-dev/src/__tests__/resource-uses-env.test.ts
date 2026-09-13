/**
 * `launch env` and `launch bootstrap` resolve a `uses`-bearing entry exactly
 * as `launch up` did (SPEC.md § Resource uses, D-65). Both rebuild the
 * resource map from state, so a redis `db` use must read back the numbered
 * database `up` recorded — not the instance url, which is the silent wrong
 * value the strict resolver exists to prevent — and a state file with no
 * recorded index must throw rather than answer it.
 *
 * `up` runs for real against a temp project dir (state, ports, env files);
 * the mock set mirrors app-url.test.ts: no subprocess, no pm2. The provisioner
 * answers the same properties for `up` and `env`, so what is compared is the
 * registration each path performs on top of them.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnresolvedUseError } from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchState } from "../state.js";

const startRegistrations: { name: string; env: Record<string, string> }[] = [];
const consoleLogs: string[] = [];

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
const { launchBootstrap } = await import("../bootstrap.js");

// Two redis resources so the second one's database (index 1) differs from
// the instance url's `/0`: a fallback to the instance url is visible.
const LAUNCHFILE = `version: launch/v1
name: usesenv
components:
  web:
    runtime: node
    commands:
      start: node web.js
      bootstrap: echo $queue.db.url
    requires:
      - type: redis
        uses: [db]
        set_env:
          CACHE_URL: $redis.db.url
      - type: redis
        name: queue
        uses: [db]
        set_env:
          QUEUE_URL: $queue.db.url
          QUEUE_DB: $queue.db.index
`;

const KEYS = ["CACHE_URL", "QUEUE_URL", "QUEUE_DB"] as const;

/** The `KEY=value` lines `env` printed, keyed by name. */
function printedEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of consoleLogs) {
		const eq = line.indexOf("=");
		if (line.startsWith("#") || eq === -1) continue;
		env[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return env;
}

function statePath(projectDir: string): string {
	return join(projectDir, ".launchfile", "state.json");
}

describe("macos-dev env — a `db` use resolves to the database `up` handed the component", () => {
	let projectDir: string;

	beforeEach(() => {
		startRegistrations.length = 0;
		consoleLogs.length = 0;
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-uses-env-"));
		writeFileSync(join(projectDir, "Launchfile"), LAUNCHFILE);
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			consoleLogs.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("`env` prints the same CACHE_URL / QUEUE_URL / QUEUE_DB `up` registered", async () => {
		await launchUp({ projectDir });
		const started = startRegistrations.find((r) => r.name === "web")?.env;
		expect(started).toBeDefined();

		consoleLogs.length = 0;
		await launchEnv({ projectDir });
		const printed = printedEnv();

		for (const key of KEYS) {
			expect(printed[key]).toBe(started![key]);
		}
		// The second resource's database, not the instance url's `/0`.
		expect(printed.QUEUE_URL).toBe("redis://localhost:6379/1");
		expect(printed.QUEUE_DB).toBe("1");
		expect(printed.CACHE_URL).toBe("redis://localhost:6379/0");
	});

	it("`up` records the allocated index in state, per resource", async () => {
		await launchUp({ projectDir });
		const state = JSON.parse(readFileSync(statePath(projectDir), "utf8")) as LaunchState;
		expect(state.resources.redis?.dbIndex).toBe(0);
		expect(state.resources.queue?.dbIndex).toBe(1);
	});

	it("`bootstrap` resolves the use to the same database", async () => {
		await launchUp({ projectDir });
		const commands: string[] = [];
		await launchBootstrap({
			projectDir,
			exec: async (_cmd: string, args: string[]) => {
				commands.push(args.at(-1) ?? "");
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		expect(commands).toEqual(["echo redis://localhost:6379/1"]);
	});

	it("`env` throws rather than answering the instance url when state records no index", async () => {
		await launchUp({ projectDir });

		// State written before the index was recorded: the resources are there,
		// their `dbIndex` is not.
		const state = JSON.parse(readFileSync(statePath(projectDir), "utf8")) as LaunchState;
		for (const res of Object.values(state.resources)) delete res.dbIndex;
		writeFileSync(statePath(projectDir), JSON.stringify(state, null, 2));

		consoleLogs.length = 0;
		await expect(launchEnv({ projectDir })).rejects.toThrow(UnresolvedUseError);
		const printed = printedEnv();
		for (const key of KEYS) {
			expect(printed[key]).toBeUndefined();
		}
	});
});
