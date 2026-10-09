/**
 * The native provider launches a directory (#448): a catalog slug or URL
 * target under `--native` (and so under `dev`, which forces the native
 * provider) is refused, not resolved to the working directory. The refusal
 * names the target as typed, loads no provider, and writes no index row
 * (D-55's floor: refuse loudly rather than silently do something else).
 *
 * Directories are injected temp paths — nothing touches the real
 * ~/.launchfile and nothing talks to docker. Every `handleUp` call passes a
 * provider flag, so `detectProvider` never spawns `docker info`.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleUp } from "../commands/up.js";
import { loadIndex } from "../state/index.js";

let indexDir: string;
let recordDir: string;
let projectDir: string;

let output: string[];
let restore: (() => void) | null = null;

beforeEach(async () => {
	const root = await mkdtemp(join(tmpdir(), "lf-native-target-"));
	indexDir = join(root, "index");
	recordDir = join(root, "records");
	projectDir = join(root, "project");
	await Promise.all([mkdir(indexDir), mkdir(recordDir), mkdir(projectDir)]);
	await writeFile(join(projectDir, "Launchfile"), "name: real\n");

	output = [];
	const log = console.log;
	const err = console.error;
	console.log = (...args: unknown[]) => output.push(args.join(" "));
	console.error = (...args: unknown[]) => output.push(args.join(" "));
	restore = () => {
		console.log = log;
		console.error = err;
	};
});

afterEach(() => {
	restore?.();
	restore = null;
});

/** Run `handleUp` with `process.exit` trapped; returns the exit code. */
async function runExpectingExit(
	target: string,
	importMacos: () => Promise<typeof import("@launchfile/macos-dev")>,
): Promise<number | undefined> {
	const exit = process.exit;
	let exited: number | undefined;
	process.exit = (code?: number) => {
		exited = code;
		throw new Error("exited");
	};
	try {
		await expect(
			handleUp(target, { native: true }, { importMacos, indexDir, recordDir }),
		).rejects.toThrow("exited");
	} finally {
		process.exit = exit;
	}
	return exited;
}

describe("--native refuses a target that is not a directory (#448)", () => {
	for (const [label, target] of [
		["a catalog slug", "ghost"],
		["a URL", "https://example.com/ghost/Launchfile"],
	] as const) {
		it(`exits 1 on ${label}, naming the target as typed, before any provider loads`, async () => {
			let imported = 0;
			const exited = await runExpectingExit(target, async () => {
				imported++;
				return {
					launchUp: async () => {},
				} as unknown as typeof import("@launchfile/macos-dev");
			});

			expect(exited).toBe(1);
			const printed = output.join("\n");
			expect(printed).toContain(`"${target}" is ${label}`);
			expect(printed).toContain("--docker");
			expect(printed).toContain("app's own directory");
			// The provider is what reads a Launchfile; it was never even imported,
			// so nothing from the working directory was read or launched.
			expect(imported).toBe(0);
			// Refused before the index is touched: no row for a launch that never ran.
			expect(Object.keys((await loadIndex(indexDir)).deployments)).toHaveLength(
				0,
			);
		});
	}

	it("still launches a real directory, keyed by that directory", async () => {
		const launched: string[] = [];
		const fake = {
			launchUp: async (opts: { projectDir: string }) => {
				launched.push(opts.projectDir);
			},
		} as unknown as typeof import("@launchfile/macos-dev");

		await handleUp(
			projectDir,
			{ native: true },
			{ importMacos: async () => fake, indexDir, recordDir },
		);

		expect(launched).toEqual([projectDir]);
		const entries = Object.values((await loadIndex(indexDir)).deployments);
		expect(entries).toHaveLength(1);
		const [entry] = entries;
		expect(entry?.provider).toBe("macos");
		expect(entry?.source).toBe(projectDir);
	});
});

describe("launchfile dev <slug> (built CLI)", () => {
	const CLI = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");

	function run(
		cliArgs: string[],
		cwd: string,
	): { output: string; exitCode: number } {
		try {
			const output = execFileSync("node", [CLI, ...cliArgs], {
				cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { output, exitCode: 0 };
		} catch (err) {
			const e = err as { stdout?: string; stderr?: string; status?: number };
			return {
				output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
				exitCode: e.status ?? 1,
			};
		}
	}

	it("refuses the slug instead of running the Launchfile in the working directory", async () => {
		// A decoy app in cwd: the bug launched this one and reported it as `ghost`.
		const decoyDir = await mkdtemp(join(tmpdir(), "lf-native-decoy-"));
		await writeFile(
			join(decoyDir, "Launchfile"),
			"name: decoy\ncomponents:\n  web:\n    start: sleep 1\n",
		);

		const { output, exitCode } = run(["dev", "ghost"], decoyDir);

		expect(exitCode).toBe(1);
		expect(output).toContain('"ghost" is a catalog slug');
		expect(output).not.toContain("decoy");
		// The pre-fix failure in an empty directory: a path the operator never typed.
		expect(output).not.toContain("No Launchfile found");
	});
});
