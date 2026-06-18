import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchDown } from "../provider.js";
import { initState, loadState, saveState } from "../state.js";

/**
 * Integration-ish coverage of `launch down`'s app-process handling.
 * We use temp dirs and state with no resources, so down only exercises the
 * process-stopping path (no brew provisioners are touched).
 */
describe("launchDown process handling (issue #49)", () => {
	async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const dir = await mkdtemp(join(tmpdir(), "launchfile-down-"));
		try {
			return await fn(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it("tolerates a state file with no recorded processes (backward compat)", async () => {
		await withTempDir(async (dir) => {
			const state = initState("legacy", "name: legacy");
			await saveState(dir, state); // no `processes` field
			// Must not throw even though there are no pids to stop.
			await expect(launchDown({ projectDir: dir })).resolves.toBeUndefined();
		});
	});

	it("skips recycled pids (identity mismatch) without crashing, and clears them", async () => {
		await withTempDir(async (dir) => {
			const state = initState("app", "name: app");
			// A pid that is almost certainly dead, recorded long ago. Even if the
			// pid happens to be alive, the ancient startedAt forces an identity
			// mismatch, so no signal is sent — safe either way.
			state.processes = {
				web: {
					pid: 999_999,
					pgid: 999_999,
					startedAt: "2000-01-01T00:00:00.000Z",
					command: "sh -c 'sleep 1'",
				},
			};
			await saveState(dir, state);

			await expect(launchDown({ projectDir: dir })).resolves.toBeUndefined();

			// down clears recorded processes after handling them.
			const after = await loadState(dir);
			expect(after?.processes).toEqual({});
		});
	});

	it("does nothing process-wise when there's no state at all", async () => {
		await withTempDir(async (dir) => {
			await expect(launchDown({ projectDir: dir })).resolves.toBeUndefined();
		});
	});
});
