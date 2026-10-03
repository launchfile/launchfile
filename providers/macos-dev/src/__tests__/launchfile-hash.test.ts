/**
 * `launchfileHash` is read on `up` (#261): a recorded hash that differs from
 * the current Launchfile text is reported once and the recorded state is
 * kept — never discarded, since that would re-mint every `generatedEnv`
 * value on an ordinary edit (D-49). The mock set mirrors app-url.test.ts:
 * `state.js`, `env-writer.js` and `port-allocator.js` run for real against a
 * temp project directory; subprocess exec and pm2 do not.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
	readFile: async (path: string, encoding?: BufferEncoding) =>
		readFileSync(path, encoding ?? "utf8"),
	writeFile: async (
		path: string,
		content: string,
		opts?: { mode?: number },
	) => {
		writeFileSync(
			path,
			content,
			opts?.mode !== undefined ? { mode: opts.mode } : undefined,
		);
	},
	mkdir: async (
		path: string,
		opts?: { recursive?: boolean; mode?: number },
	) => {
		mkdirSync(path, opts);
	},
	chmod: async (path: string, mode: number) => {
		chmodSync(path, mode);
	},
}));

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
const { hashLaunchfile, initState, saveState } = await import("../state.js");

const LAUNCHFILE = `version: launch/v1
name: hashtest
runtime: node
provides:
  - port: 3000
    protocol: http
env:
  APP_KEY:
    generator: secret
commands:
  start: "node server.js"
`;

describe("launchfileHash is read on up (#261)", () => {
	let projectDir: string;
	let warnings: string[];

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-hash-"));
		writeFileSync(join(projectDir, "Launchfile"), LAUNCHFILE);
		warnings = [];
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(projectDir, { recursive: true, force: true });
	});

	const onDisk = () =>
		JSON.parse(
			readFileSync(join(projectDir, ".launchfile", "state.json"), "utf8"),
		) as { launchfileHash: string; generatedEnv?: Record<string, string> };

	it("warns, keeps the recorded state, and records the current hash on a mismatch", async () => {
		const mintedKey = "m".repeat(64);
		const state = initState("hashtest", "name: something-else\n");
		state.generatedEnv = { "default.APP_KEY": mintedKey };
		await saveState(projectDir, state);

		// A dry run reaches the comparison and saves state before it returns.
		await launchUp({ projectDir, dryRun: true });

		const printed = warnings.join("\n");
		expect(printed).toContain("recorded for different Launchfile content");
		expect(printed).toContain(
			`recorded ${hashLaunchfile("name: something-else\n")}`,
		);
		expect(printed).toContain(`current ${hashLaunchfile(LAUNCHFILE)}`);
		expect(printed).toContain("continuing with the recorded state");
		// Generate once, then preserve (D-49): the edit did not re-mint the key.
		expect(onDisk().generatedEnv).toEqual({ "default.APP_KEY": mintedKey });
		expect(onDisk().launchfileHash).toBe(hashLaunchfile(LAUNCHFILE));
	});

	it("stays silent when the Launchfile is unchanged", async () => {
		await saveState(projectDir, initState("hashtest", LAUNCHFILE));
		await launchUp({ projectDir, dryRun: true });
		expect(warnings.join("\n")).not.toContain("recorded for different");
		expect(onDisk().launchfileHash).toBe(hashLaunchfile(LAUNCHFILE));
	});

	it("stays silent on a first run, which has no recorded state", async () => {
		await launchUp({ projectDir, dryRun: true });
		expect(warnings.join("\n")).not.toContain("recorded for different");
		expect(onDisk().launchfileHash).toBe(hashLaunchfile(LAUNCHFILE));
	});

	it("stays silent when the recorded file carries no hash, and records one", async () => {
		const state = initState("hashtest", LAUNCHFILE);
		delete (state as Partial<typeof state>).launchfileHash;
		await saveState(projectDir, state);
		await launchUp({ projectDir, dryRun: true });
		expect(warnings.join("\n")).not.toContain("recorded for different");
		expect(onDisk().launchfileHash).toBe(hashLaunchfile(LAUNCHFILE));
	});
});
