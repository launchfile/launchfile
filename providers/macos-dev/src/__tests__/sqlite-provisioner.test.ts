/**
 * SqliteProvisioner: the trust boundary around `.launchfile/data/sqlite`.
 *
 * `provision()` hands the app the path it will write its database through,
 * and `destroy()` turns a value read out of `.launchfile/state.json` into a
 * filesystem delete. Both `.launchfile/` and the state file live inside the
 * cloned repo — the state file is parsed without validation (`state.ts`) —
 * so the data path is attacker-controlled on the way in and `dbName` on the
 * way out. Both sides confine themselves to the directory under the real
 * project root.
 */

import {
	mkdir,
	mkdtemp,
	readdir,
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
import { ResourceRefusedError } from "../resources/types.js";
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

describe("SqliteProvisioner.provision", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A repo-shaped project whose `.launchfile/<rel>` is a symlink to `target`. */
	async function projectWithSymlink(
		rel: string[],
		target: string,
	): Promise<string> {
		const projectDir = await mkdtemp(join(tmpdir(), "lf-sqlite-provision-"));
		const link = join(projectDir, ".launchfile", ...rel);
		await mkdir(join(link, ".."), { recursive: true });
		await symlink(target, link);
		return projectDir;
	}

	it("hands out a path under the real project's .launchfile/data/sqlite", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "lf-sqlite-provision-"));

		const { properties, state } = await new SqliteProvisioner().provision(REQ, {
			appName: "my-app",
			projectDir,
		});

		// tmpdir() is itself a symlink on macOS; the anchor is its real path.
		expect(properties.path).toMatch(
			/\/\.launchfile\/data\/sqlite\/my_app\.db$/,
		);
		expect(properties.url).toBe(`sqlite://${properties.path}`);
		expect(state.dbName).toBe(properties.path);
		expect(
			await readdir(join(projectDir, ".launchfile", "data", "sqlite")),
		).toEqual([]);
	});

	it("refuses when .launchfile/data/sqlite is a symlink out of the project", async () => {
		// mkdir({ recursive: true }) succeeds through a symlink to a directory
		// and reports nothing; the app would then write its db into the target.
		const victimDir = await mkdtemp(join(tmpdir(), "lf-victim-"));
		const projectDir = await projectWithSymlink(["data", "sqlite"], victimDir);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(
			new SqliteProvisioner().provision(
				{ type: "sqlite", name: "db" } as NormalizedRequirement,
				{ appName: "my-app", projectDir },
			),
		).rejects.toBeInstanceOf(ResourceRefusedError);

		expect(await readdir(victimDir)).toEqual([]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("refusing to provision db"),
		);
	});

	it("refuses when .launchfile/data is a symlink out of the project", async () => {
		// A check that resolves the data path and compares it to a resolved
		// root passes this one through: both ends agree on the target. Only
		// an unresolved root joined onto realpath(projectDir) catches it.
		const victimDir = await mkdtemp(join(tmpdir(), "lf-victim-"));
		const projectDir = await projectWithSymlink(["data"], victimDir);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(
			new SqliteProvisioner().provision(REQ, { appName: "my-app", projectDir }),
		).rejects.toBeInstanceOf(ResourceRefusedError);

		expect(await readdir(victimDir)).toEqual([]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("refusing to provision sqlite"),
		);
	});

	it("refuses when a component is a regular file", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "lf-sqlite-provision-"));
		await mkdir(join(projectDir, ".launchfile"));
		await writeFile(join(projectDir, ".launchfile", "data"), "not a directory");
		vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(
			new SqliteProvisioner().provision(REQ, { appName: "my-app", projectDir }),
		).rejects.toMatchObject({
			resourceName: "sqlite",
			reason: expect.stringContaining("not a directory"),
		});
	});
});

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
