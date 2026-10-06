/**
 * SQLite resource provisioner — just creates a directory for the DB file.
 */

import { realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { NormalizedRequirement } from "@launchfile/sdk";
import { ConfinementRefusal, ensureConfinedDir } from "../safe-path.js";
import type { ResourceState } from "../state.js";
import {
	type DestroyOpts,
	type ProvisionOpts,
	type ProvisionResult,
	type ResourceProperties,
	type ResourceProvisioner,
	ResourceRefusedError,
} from "./types.js";
import { versionWarning } from "./version.js";

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
	): Promise<ProvisionResult> {
		const resourceName = req.name ?? req.type;
		const safeName = opts.appName.replace(/-/g, "_");

		// The refusal happens before `path`/`url` exist: this provisioner
		// writes no database bytes itself, the app does, through whatever
		// path it is handed. A refused data path is a refused resource, so the
		// caller's loop can skip an optional one; the reason prints here
		// because that loop reports only "skipped".
		let dataDir: string;
		try {
			dataDir = await ensureConfinedDir(opts.projectDir, DATA_DIR, {
				mode: 0o700,
			});
		} catch (err) {
			if (err instanceof ConfinementRefusal)
				refuse(resourceName, `${err.path} ${err.reason}`);
			throw err;
		}

		const dbPath = join(dataDir, `${safeName}.db`);

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

		// No server runs here: this provider creates the file and provides no
		// SQLite library, so there is no version to compare a range against.
		const warning = versionWarning(
			req,
			"the database file it creates",
			undefined,
			"provides only the database file, no SQLite library, so it reads no SQLite version",
		);

		return { properties, state, warnings: warning ? [warning] : [] };
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
