import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { initState, hashLaunchfile, loadState, saveState, type LaunchState } from "../state.js";

describe("initState", () => {
	it("creates a state with correct app name", () => {
		const state = initState("my-app", "name: my-app");
		expect(state.appName).toBe("my-app");
		expect(state.version).toBe(1);
		expect(state.resources).toEqual({});
		expect(state.secrets).toEqual({});
		expect(state.ports).toEqual({});
	});

	it("hashes launchfile content", () => {
		const state = initState("app", "some yaml content");
		expect(state.launchfileHash).toBeTruthy();
		expect(state.launchfileHash.length).toBe(16);
	});
});

describe("hashLaunchfile", () => {
	it("is deterministic", () => {
		const a = hashLaunchfile("hello");
		const b = hashLaunchfile("hello");
		expect(a).toBe(b);
	});

	it("differs for different content", () => {
		const a = hashLaunchfile("hello");
		const b = hashLaunchfile("world");
		expect(a).not.toBe(b);
	});
});

describe("state persistence of processes (issue #49)", () => {
	async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const dir = await mkdtemp(join(tmpdir(), "launchfile-state-"));
		try {
			return await fn(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it("round-trips the processes field (pid/pgid/startedAt/command)", async () => {
		await withTempDir(async (dir) => {
			const state = initState("my-app", "name: my-app");
			state.processes = {
				web: { pid: 1234, pgid: 1234, startedAt: "2026-06-18T00:00:00.000Z", command: "sh -c 'bun start'" },
			};
			await saveState(dir, state);

			const loaded = await loadState(dir);
			expect(loaded?.processes?.web).toEqual({
				pid: 1234,
				pgid: 1234,
				startedAt: "2026-06-18T00:00:00.000Z",
				command: "sh -c 'bun start'",
			});
		});
	});

	it("initState omits processes (field is optional, absent by default)", () => {
		const state = initState("app", "yaml");
		expect(state.processes).toBeUndefined();
	});

	it("loads a legacy state.json that has no processes field (backward compatible)", async () => {
		await withTempDir(async (dir) => {
			// Write a state object shaped like a pre-pid-persistence file.
			const legacy: LaunchState = initState("legacy", "name: legacy");
			// Ensure the field truly isn't present on disk.
			expect("processes" in legacy).toBe(false);
			await saveState(dir, legacy);

			const loaded = await loadState(dir);
			expect(loaded).not.toBeNull();
			expect(loaded?.processes).toBeUndefined();
			// `down` reads `state.processes ?? {}` — prove that defaulting works.
			expect(loaded?.processes ?? {}).toEqual({});
		});
	});
});
