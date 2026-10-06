/**
 * SQLite resource provisioner — just creates a directory for the DB file.
 */

import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { NormalizedRequirement } from "@launchfile/sdk";
import type { ResourceState } from "../state.js";
import {
	type DestroyOpts,
	type ProvisionOpts,
	type ResourceProperties,
	type ResourceProvisioner,
	ResourceRefusedError,
} from "./types.js";

const DATA_DIR = [".launchfile", "data", "sqlite"] as const;

/**
 * The directory this provisioner owns: `.launchfile/data/sqlite` joined
 * lexically onto `realpath(projectDir)`. `.launchfile/` ships inside the
 * cloned repository, so the data path is repo-controlled and is never
 * resolved itself — resolving both ends would pass a symlinked component
 * through, since both sides then agree on the symlink's target. The project
 * root comes from the caller and is the only trustworthy anchor; every
 * path `provision()` hands out and `destroy()` deletes is confined to it.
 *
 * Returns null when the project directory does not exist.
 */
async function anchoredDataDir(
	projectDir: string,
): Promise<{ projectRoot: string; dataDir: string } | null> {
	const projectRoot = await realpath(projectDir).catch(() => null);
	if (projectRoot === null) return null;
	return { projectRoot, dataDir: join(projectRoot, ...DATA_DIR) };
}

/**
 * Creates the data directory under `projectRoot`, refusing when any
 * component of `.launchfile/data/sqlite` already exists as something other
 * than a real directory. `mkdir(..., { recursive: true })` succeeds through a
 * symlink to a directory and reports nothing, so the check uses `lstat`
 * (which does not follow symlinks) on each component before anything is
 * created — `realpath` cannot do it, as the path does not exist on a first
 * run. After the mkdir the directory must still resolve to itself.
 *
 * Returns the reason for a refusal, or null when the directory is ready.
 */
async function createDataDir(projectRoot: string): Promise<string | null> {
	let path = projectRoot;
	for (const component of DATA_DIR) {
		path = join(path, component);
		const entry = await lstat(path).catch(() => null);
		if (entry !== null && !entry.isDirectory()) {
			return `${path} ${entry.isSymbolicLink() ? "is a symlink" : "is not a directory"}`;
		}
	}
	await mkdir(path, { recursive: true });
	const real = await realpath(path).catch(() => null);
	if (real !== path) {
		return `${path} resolves to ${real ?? "nothing"}`;
	}
	return null;
}

function refuse(resourceName: string, reason: string): never {
	console.warn(`  ! sqlite: refusing to provision ${resourceName} — ${reason}`);
	throw new ResourceRefusedError(resourceName, reason);
}

export class SqliteProvisioner implements ResourceProvisioner {
	readonly type = "sqlite";

	async isRunning(): Promise<boolean> {
		return true; // SQLite is always available
	}

	async provision(
		req: NormalizedRequirement,
		opts: ProvisionOpts,
	): Promise<{ properties: ResourceProperties; state: ResourceState }> {
		const resourceName = req.name ?? req.type;
		const safeName = opts.appName.replace(/-/g, "_");

		// The refusal happens before `path`/`url` exist: this provisioner
		// writes no database bytes itself, the app does, through whatever
		// path it is handed. The reason prints here because the caller's
		// optional-resource loop reports only "skipped".
		const anchored = await anchoredDataDir(opts.projectDir);
		if (anchored === null)
			refuse(resourceName, `${opts.projectDir} does not exist`);
		const reason = await createDataDir(anchored.projectRoot);
		if (reason !== null) refuse(resourceName, reason);

		const dbPath = join(anchored.dataDir, `${safeName}.db`);

		// SPEC.md § Resource Property Vocabulary gives sqlite `url` and `path`
		// only. A file has no host and no port, so neither is exposed.
		const properties: ResourceProperties = {
			url: `sqlite://${dbPath}`,
			path: dbPath,
		};

		const state: ResourceState = {
			type: "sqlite",
			name: resourceName,
			port: 0,
			dbName: dbPath,
		};

		return { properties, state };
	}

	async destroy(state: ResourceState, opts: DestroyOpts): Promise<void> {
		if (!state.dbName) return;

		// state.json is repo-supplied and parsed without validation (state.ts),
		// so dbName is untrusted here. resolve() is lexical and would not see
		// a symlinked data directory, while fs.rm follows symlinked components
		// at the OS layer, so the target's real parent is compared against the
		// anchored root instead.
		// The trailing separator matters: a bare startsWith(root) would leave a
		// sibling directory named `sqlite-evil` deletable.
		const anchored = await anchoredDataDir(opts.projectDir);
		if (anchored === null) return;

		const root = anchored.dataDir;
		const target = resolve(anchored.projectRoot, state.dbName);
		const parent = await realpath(dirname(target)).catch(() => null);
		if (parent === null) return; // nothing at that path to delete

		const real = join(parent, basename(target));
		if (!real.startsWith(root + sep)) {
			console.warn(
				`  ! sqlite: refusing to delete ${target} — outside ${root}`,
			);
			return;
		}

		await rm(real, { force: true });
	}
}
