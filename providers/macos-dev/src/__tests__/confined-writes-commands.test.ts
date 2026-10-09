/**
 * `down`, `env` and `bootstrap` against a repository that ships
 * `.launchfile/state.json` as a symlink (#655). Each command reaches its
 * state write, refuses it with one `Refused:` line and exit 1, prints no
 * stack trace, and leaves the file the link points at untouched.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../process-stopper.js", () => ({
	stopRecordedProcesses: async (recorded: Record<string, unknown>) =>
		Object.keys(recorded).map((component) => ({
			component,
			result: "already-dead",
		})),
}));

const { launchDown, launchEnv } = await import("../provider.js");
const { launchBootstrap } = await import("../bootstrap.js");

const LAUNCHFILE = `
name: app
components:
  web:
    runtime: node
    commands:
      start: "node server.js"
      bootstrap:
        command: "true"
    env:
      TOKEN:
        generator: secret
`;

function stateJson(extra: Record<string, unknown> = {}): string {
	const now = new Date().toISOString();
	return `${JSON.stringify({
		version: 1,
		appName: "app",
		launchfileHash: "0".repeat(16),
		createdAt: now,
		updatedAt: now,
		resources: {},
		secrets: {},
		ports: { web: 3000 },
		...extra,
	})}\n`;
}

describe("macos-dev down/env/bootstrap — a symlinked state.json (#655)", () => {
	let projectDir: string;
	let victimDir: string;
	let victim: string;
	let exitCode: number | undefined;
	const consoleErrors: string[] = [];

	beforeEach(() => {
		consoleErrors.length = 0;
		exitCode = undefined;
		projectDir = mkdtempSync(join(tmpdir(), "lf-macos-confined-cmd-"));
		victimDir = mkdtempSync(join(tmpdir(), "lf-macos-confined-cmd-victim-"));
		victim = join(victimDir, "state.json");
		writeFileSync(join(projectDir, "Launchfile"), LAUNCHFILE);
		mkdirSync(join(projectDir, ".launchfile"));
		symlinkSync(victim, join(projectDir, ".launchfile", "state.json"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			consoleErrors.push(args.map(String).join(" "));
		});
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

	function expectRefused(): void {
		expect(exitCode).toBe(1);
		expect(consoleErrors).toEqual([
			`Refused: ${join(realpathSync(projectDir), ".launchfile", "state.json")} is a symlink to ${victim}; refusing to write`,
		]);
		expect(consoleErrors.join("\n")).not.toMatch(/^\s+at /m);
	}

	it("down refuses the state write and leaves the target untouched", async () => {
		const original = stateJson({
			processes: {
				web: {
					pid: 999_999,
					pgid: 999_999,
					startedAt: new Date().toISOString(),
					command: "node server.js",
				},
			},
		});
		writeFileSync(victim, original);

		await expect(launchDown({ projectDir })).rejects.toThrow("__exit__1");

		expectRefused();
		expect(readFileSync(victim, "utf8")).toBe(original);
	});

	it("env refuses the state write and leaves the target untouched", async () => {
		const original = stateJson();
		writeFileSync(victim, original);

		await expect(launchEnv({ projectDir })).rejects.toThrow("__exit__1");

		expectRefused();
		expect(readFileSync(victim, "utf8")).toBe(original);
	});

	it("bootstrap refuses the state write before running any command", async () => {
		const original = stateJson();
		writeFileSync(victim, original);
		const ran: string[][] = [];

		await expect(
			launchBootstrap({
				projectDir,
				exec: async (cmd, args) => {
					ran.push([cmd, ...args]);
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			}),
		).rejects.toThrow("__exit__1");

		expectRefused();
		expect(ran).toEqual([]);
		expect(readFileSync(victim, "utf8")).toBe(original);
	});
});
