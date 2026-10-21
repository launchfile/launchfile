/**
 * Every directory this provider creates under `.launchfile/` is owner-only,
 * whatever mode it had before (#408, CWE-276). `ensureDirs` is covered in
 * state.test.ts; these are the other three creation sites.
 *
 * Loose modes are set with an explicit `chmod`, never `mkdir`'s `mode`: that
 * one is masked by the umask, so under a restrictive umask the fixture would be
 * born 0o700 and the assertion would pass without the retrofit running.
 */

import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedRequirement } from "@launchfile/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteProvisioner } from "../resources/sqlite.js";
import { initState, saveState } from "../state.js";
import { provisionStorage } from "../storage.js";

let projectDir: string;

beforeEach(async () => {
	projectDir = await mkdtemp(join(tmpdir(), "lf-dir-modes-"));
});

afterEach(async () => {
	await rm(projectDir, { recursive: true, force: true });
});

async function mode(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

async function looseDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
	await chmod(path, 0o755);
}

describe("saveState", () => {
	const stateDir = () => join(projectDir, ".launchfile");

	it("creates .launchfile at 0o700 and state.json at 0o600", async () => {
		await saveState(projectDir, initState("app", "name: app"));
		expect(await mode(stateDir())).toBe(0o700);
		expect(await mode(join(stateDir(), "state.json"))).toBe(0o600);
	});

	it("tightens a pre-existing .launchfile left at 0o755", async () => {
		await looseDir(stateDir());
		await saveState(projectDir, initState("app", "name: app"));
		expect(await mode(stateDir())).toBe(0o700);
	});
});

describe("provisionStorage", () => {
	const storage = {
		uploads: { path: "/data/uploads", persistent: true },
		cache: { path: "/data/cache", persistent: false },
	};

	it("creates persistent and ephemeral volume directories at 0o700", async () => {
		const paths = await provisionStorage(storage, "web", projectDir);
		for (const localPath of Object.values(paths)) {
			expect(await mode(localPath)).toBe(0o700);
		}
	});

	it("tightens a pre-existing volume directory left at 0o755", async () => {
		const uploads = join(
			projectDir,
			".launchfile",
			"storage",
			"web",
			"uploads",
		);
		await looseDir(uploads);
		await provisionStorage(storage, "web", projectDir);
		expect(await mode(uploads)).toBe(0o700);
	});
});

describe("SqliteProvisioner.provision", () => {
	const REQ = { type: "sqlite" } as NormalizedRequirement;
	const dataDir = () => join(projectDir, ".launchfile", "data", "sqlite");

	it("creates the data directory at 0o700", async () => {
		await new SqliteProvisioner().provision(REQ, {
			appName: "app",
			projectDir,
		});
		expect(await mode(dataDir())).toBe(0o700);
	});

	it("tightens a pre-existing data directory left at 0o755", async () => {
		await looseDir(dataDir());
		await new SqliteProvisioner().provision(REQ, {
			appName: "app",
			projectDir,
		});
		expect(await mode(dataDir())).toBe(0o700);
	});
});
