/**
 * SqliteProvisioner teardown.
 *
 * `destroy()` is the one place this provider turns a value read out of
 * `.launchfile/state.json` into a filesystem delete. The state file lives
 * inside the cloned repo and is parsed without validation (`state.ts`), so
 * `dbName` is attacker-controlled and the delete has to be confined to the
 * directory `provision()` writes to.
 */

import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedRequirement } from "@launchfile/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteProvisioner } from "../resources/sqlite.js";
import type { ResourceState } from "../state.js";

const REQ = { type: "sqlite" } as NormalizedRequirement;

/** Runs `provision()` for real in a scratch project and creates the db file. */
async function provisionedProject(): Promise<{
	projectDir: string;
	state: ResourceState;
}> {
	const projectDir = await mkdtemp(join(tmpdir(), "lf-sqlite-destroy-"));
	const { state } = await new SqliteProvisioner().provision(REQ, {
		appName: "my-app",
		projectDir,
	});
	await writeFile(String(state.dbName), "sqlite-bytes");
	return { projectDir, state };
}

async function exists(path: string): Promise<boolean> {
	return readFile(path, "utf8").then(
		() => true,
		() => false,
	);
}

describe("SqliteProvisioner.destroy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("deletes the database file provision() created", async () => {
		const { projectDir, state } = await provisionedProject();

		await new SqliteProvisioner().destroy(state, { projectDir });

		expect(await exists(String(state.dbName))).toBe(false);
	});

	it("refuses a path outside the project and says so", async () => {
		const { projectDir } = await provisionedProject();
		const outside = join(
			await mkdtemp(join(tmpdir(), "lf-victim-")),
			"id_ed25519",
		);
		await writeFile(outside, "private key");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await new SqliteProvisioner().destroy(
			{ type: "sqlite", name: "db", port: 0, dbName: outside },
			{ projectDir },
		);

		expect(await exists(outside)).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("refusing to delete"),
		);
	});

	it("refuses a sibling directory whose name merely starts with the root", async () => {
		// The confinement compares against `root + sep`. Without the separator,
		// `.launchfile/data/sqlite-evil/` would pass the prefix check.
		const { projectDir } = await provisionedProject();
		const sibling = join(projectDir, ".launchfile", "data", "sqlite-evil");
		await mkdir(sibling, { recursive: true });
		const loot = join(sibling, "loot.db");
		await writeFile(loot, "not ours");
		vi.spyOn(console, "warn").mockImplementation(() => {});

		await new SqliteProvisioner().destroy(
			{ type: "sqlite", name: "db", port: 0, dbName: loot },
			{ projectDir },
		);

		expect(await exists(loot)).toBe(true);
	});

	it("refuses a path whose directory is a symlink out of the project", async () => {
		// resolve() is lexical, so a symlinked data directory passes a
		// string-prefix check while fs.rm follows it at the OS layer. The repo
		// supplies .launchfile/, so it can ship that symlink.
		const { projectDir } = await provisionedProject();
		const victimDir = await mkdtemp(join(tmpdir(), "lf-victim-"));
		const victim = join(victimDir, "id_ed25519");
		await writeFile(victim, "private key");

		const dataDir = join(projectDir, ".launchfile", "data", "sqlite");
		await rm(dataDir, { recursive: true, force: true });
		await symlink(victimDir, dataDir);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await new SqliteProvisioner().destroy(
			{
				type: "sqlite",
				name: "db",
				port: 0,
				dbName: join(dataDir, "id_ed25519"),
			},
			{ projectDir },
		);

		expect(await exists(victim)).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("refusing to delete"),
		);
	});

	it("does nothing when the state carries no dbName", async () => {
		const { projectDir } = await provisionedProject();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await new SqliteProvisioner().destroy(
			{ type: "sqlite", name: "db", port: 0 },
			{ projectDir },
		);

		expect(warn).not.toHaveBeenCalled();
	});
});
