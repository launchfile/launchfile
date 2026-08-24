/**
 * Behavioral coverage for env-level generator preservation (D-49, #186):
 * two consecutive REAL `launchfile up` runs must give the container the same
 * minted value, through the actual saveState → loadState → reuse path that
 * pure `launchToCompose` tests stub out. A --dry-run pair proves nothing here:
 * dry-run returns before saveState.
 *
 * Uses a dedicated tiny app (alpine + sleep) under the compose project
 * `launchfile-gov23-envgen`, torn down via the provider's own destroy path.
 * Skipped when Docker is not available — the rest of the suite stays runnable
 * anywhere.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPrereqs } from "../prereqs.js";
import { dockerDown, dockerUp } from "../provider.js";
import { composePath, stateDir, type DockerState } from "../state.js";

const prereqs = await checkPrereqs();

const LAUNCHFILE = `version: launch/v1
name: gov23-envgen
image: alpine:3.20
commands:
  start: sleep 300
env:
  GOV23_TOKEN:
    generator: secret
`;

async function readState(slug: string): Promise<DockerState> {
	return JSON.parse(await readFile(join(stateDir(slug), "state.json"), "utf8")) as DockerState;
}

// describe.runIf is a vitest-only API; CI's bun test runner doesn't provide it.
const describeIfPrereqsOk = prereqs.ok ? describe : describe.skip;

describeIfPrereqsOk("env-level generator lifecycle — real up/down (D-49, #186)", () => {
	let dir: string;
	let slug: string | undefined;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "gov23-envgen-"));
		await writeFile(join(dir, "Launchfile"), LAUNCHFILE);
	});

	afterAll(async () => {
		// Safety net if the test failed mid-way: remove the containers and
		// state we created, via the provider's own destroy path. Touches only
		// the launchfile-gov23-envgen compose project.
		if (slug) await dockerDown({ slug, destroy: true }).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});

	it("preserves the value across down + a second real up; destroy discards it", async () => {
		// Run 1: mints and persists.
		const up1 = await dockerUp(dir, {});
		slug = up1.slug;
		expect(slug).toBe("gov23-envgen");

		const state1 = await readState(slug);
		const first = state1.generatedEnv?.["default.GOV23_TOKEN"];
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		// The running container's compose file carries the same value.
		expect(await readFile(composePath(slug), "utf8")).toContain(first!);

		// `down` (no --destroy) preserves the value.
		await dockerDown({ slug });
		expect((await readState(slug)).generatedEnv?.["default.GOV23_TOKEN"]).toBe(first);

		// Run 2: a real second `up` reuses it — saveState → loadState → reuse.
		await dockerUp(dir, {});
		expect((await readState(slug)).generatedEnv?.["default.GOV23_TOKEN"]).toBe(first);
		expect(await readFile(composePath(slug), "utf8")).toContain(first!);

		// `down --destroy` discards the value with the rest of the state dir.
		await dockerDown({ slug, destroy: true });
		await expect(stat(stateDir(slug))).rejects.toThrow();
		// Destroyed — the afterAll safety net must not run dockerDown again
		// (a missing state makes it process.exit(1), killing the worker).
		slug = undefined;
	}, 300_000);
});
