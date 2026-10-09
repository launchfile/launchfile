/**
 * D-25: when `components:` is present, top-level component fields are
 * defaults. A component that omits a field gets the top-level value; a
 * component that declares it replaces the value whole (no deep merge).
 *
 * These fixtures run `launchUp` against a temp project and pin that each
 * process it registers carries the resolved value for every inherited field
 * this provider reads: `env`, `commands` and `health`. Storage is out of
 * scope here (#361).
 *
 * The mock set mirrors resource-uses-env.test.ts: no subprocess, no pm2.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedHealth } from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Registration {
	command: string;
	env: Record<string, string>;
	health?: NormalizedHealth;
}

const registrations = new Map<string, Registration>();

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
		register(name: string, opts: Registration) {
			registrations.set(name, opts);
		}
		async startAll() {}
		async stopAll() {}
		getRecordedProcesses() {
			return {};
		}
	},
}));

const { launchUp } = await import("../provider.js");

const TOP_LEVEL = `version: launch/v1
name: d25app
runtime: node
env:
  SHARED_FLAG:
    default: "top"
commands:
  start: "serve --top"
health:
  command: "check --top"
`;

const INHERIT = `${TOP_LEVEL}components:
  web: {}
  worker: {}
`;

const OVERRIDE = `${TOP_LEVEL}components:
  web: {}
  worker:
    env:
      WORKER_ONLY:
        default: "own"
    commands:
      start: "work --own"
    health:
      command: "check --own"
`;

describe("macos-dev up — D-25 top-level component fields are inherited into components:", () => {
	let projectDir: string;

	async function up(launchfile: string): Promise<void> {
		writeFileSync(join(projectDir, "Launchfile"), launchfile);
		await launchUp({ projectDir, noBuild: true });
	}

	function registered(component: string): Registration {
		const reg = registrations.get(component);
		if (!reg) throw new Error(`no process registered for "${component}"`);
		return reg;
	}

	beforeEach(() => {
		registrations.clear();
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-d25-"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("D-25: both components omit env/commands/health and carry the top-level values", async () => {
		await up(INHERIT);
		for (const name of ["web", "worker"]) {
			const reg = registered(name);
			expect(reg.env.SHARED_FLAG).toBe("top");
			expect(reg.command).toBe("serve --top");
			expect(reg.health?.command).toBe("check --top");
		}
	});

	it("D-25: a component's own value replaces the top-level value whole, and the sibling still inherits", async () => {
		await up(OVERRIDE);

		const worker = registered("worker");
		expect(worker.env.WORKER_ONLY).toBe("own");
		// Shallow replacement: the component's env replaces, never merges.
		expect(worker.env.SHARED_FLAG).toBeUndefined();
		expect(worker.command).toBe("work --own");
		expect(worker.health?.command).toBe("check --own");

		const web = registered("web");
		expect(web.env.SHARED_FLAG).toBe("top");
		expect(web.env.WORKER_ONLY).toBeUndefined();
		expect(web.command).toBe("serve --top");
		expect(web.health?.command).toBe("check --top");
	});
});
