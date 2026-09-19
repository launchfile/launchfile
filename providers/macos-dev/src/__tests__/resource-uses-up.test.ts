/**
 * `launch up` registers a resource from the pooled `uses` of every same-name
 * entry (D-24: they describe one resource). The resource is provisioned once
 * per name, so registering only the first entry's uses would leave a later
 * entry's `$<resource>.<use>.<property>` references unanswerable — and the
 * strict resolver (SPEC.md § Resource uses) would throw for a file that is
 * right. Dry-run reaches the same registration and resolution code with
 * placeholder properties, so nothing is provisioned here.
 *
 * The mock set mirrors operator-storage.test.ts: no subprocess, no pm2.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		register() {}
		async startAll() {}
		async stopAll() {}
		getRecordedProcesses() {
			return {};
		}
	},
}));

const { launchUp } = await import("../provider.js");

// `worker` declares only pubsub and is seen first; `web` declares db and
// references it. Same resource name, different uses.
const TWO_COMPONENTS = `
name: app
components:
  worker:
    runtime: node
    commands: { start: "node worker.js" }
    requires:
      - type: redis
        uses: [pubsub]
        set_env:
          PUBSUB_URL: $url
  web:
    runtime: node
    commands: { start: "node web.js" }
    requires:
      - type: redis
        uses: [db]
        set_env:
          CACHE_URL: $redis.db.url
          CACHE_DB: $redis.db.index
`;

describe("macos-dev up — same-name entries pool their uses (D-24)", () => {
	let projectDir: string;

	beforeEach(() => {
		consoleLogs.length = 0;
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-uses-up-"));
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			consoleLogs.push(args.map(String).join(" "));
		});
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

	it("wires a later entry's use even though an earlier same-name entry did not declare it", async () => {
		writeFileSync(join(projectDir, "Launchfile"), TWO_COMPONENTS);
		await launchUp({ projectDir, dryRun: true });
		const log = consoleLogs.join("\n");
		expect(log).toContain("[dry-run] Env for worker: PUBSUB_URL");
		expect(log).toContain("[dry-run] Env for web: CACHE_URL, CACHE_DB");
	});
});
