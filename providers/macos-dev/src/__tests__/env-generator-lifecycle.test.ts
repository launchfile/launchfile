/**
 * Behavioral coverage for env-level generator preservation (D-49, #186):
 * two consecutive REAL `launch up` runs must hand the component the same
 * minted value, through the actual saveState → loadState → reuse path that
 * pure resolver tests stub out. Also proves the three-call-site agreement:
 * `env` reports the value the running component received.
 *
 * Skipped when the host lacks this provider's prerequisites (brew/git) —
 * everything else in the suite stays runnable anywhere.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkPrereqs } from "../prereqs.js";
import { launchDown, launchEnv, launchUp } from "../provider.js";
import type { LaunchState } from "../state.js";

const prereqs = await checkPrereqs();

// Host-safe: the only process started is a plain `sleep`, owned and stopped
// by this test via the provider's own down path.
const LAUNCHFILE = `version: launch/v1
name: gov23-envgen-macos
commands:
  start: sleep 60
env:
  GOV23_TOKEN:
    generator: secret
`;

function parseEnvFile(content: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const eq = line.indexOf("=");
		if (line.startsWith("#") || eq === -1) continue;
		env[line.slice(0, eq)] = line.slice(eq + 1).replace(/^"|"$/g, "");
	}
	return env;
}

async function readState(dir: string): Promise<LaunchState> {
	return JSON.parse(await readFile(join(dir, ".launchfile", "state.json"), "utf8")) as LaunchState;
}

describe.runIf(prereqs.ok)("env-level generator lifecycle — real up/down (D-49, #186)", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "gov23-envgen-macos-"));
		await writeFile(join(dir, "Launchfile"), LAUNCHFILE);
	});

	afterAll(async () => {
		// Safety net if the test failed mid-way: stop the sleep we spawned and
		// remove all state, via the provider's own destroy path.
		await launchDown({ destroy: true, projectDir: dir }).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});

	it("preserves the value across down + a second real up, `env` agrees, destroy discards", async () => {
		// Run 1: mints and persists.
		await launchUp({ projectDir: dir });
		const first = parseEnvFile(await readFile(join(dir, ".env.local"), "utf8")).GOV23_TOKEN!;
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect((await readState(dir)).generatedEnv?.["default.GOV23_TOKEN"]).toBe(first);

		// `down` (no --destroy) preserves the value.
		await launchDown({ projectDir: dir });
		expect((await readState(dir)).generatedEnv?.["default.GOV23_TOKEN"]).toBe(first);

		// Run 2: a real second `up` reuses it — saveState → loadState → reuse.
		await launchUp({ projectDir: dir });
		expect(parseEnvFile(await readFile(join(dir, ".env.local"), "utf8")).GOV23_TOKEN).toBe(first);

		// `env` reports the value the running component received, not a fresh mint.
		const lines: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		try {
			await launchEnv({ projectDir: dir });
		} finally {
			logSpy.mockRestore();
		}
		const printed = lines.find((line) => line.startsWith("GOV23_TOKEN="));
		expect(printed).toBe(`GOV23_TOKEN=${first}`);

		// `down --destroy` discards the value with the rest of the state dir.
		await launchDown({ destroy: true, projectDir: dir });
		await expect(stat(join(dir, ".launchfile"))).rejects.toThrow();
	}, 120_000);
});
