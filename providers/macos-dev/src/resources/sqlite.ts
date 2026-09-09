/**
 * SQLite resource provisioner — just creates a directory for the DB file.
 */

import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { NormalizedRequirement } from "@launchfile/sdk";
import type { ResourceState } from "../state.js";
import type {
	DestroyOpts,
	ProvisionOpts,
	ResourceProperties,
	ResourceProvisioner,
} from "./types.js";

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
		const dataDir = join(opts.projectDir, ".launchfile", "data", "sqlite");
		await mkdir(dataDir, { recursive: true });

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

		return { properties, state };
	}

	async destroy(state: ResourceState, opts: DestroyOpts): Promise<void> {
		if (!state.dbName) return;

		// state.json is repo-supplied and parsed without validation (state.ts),
		// so dbName is untrusted here. The repo also supplies .launchfile/, so
		// the data directory itself can be a symlink: resolve() is lexical and
		// would not see it, while fs.rm follows symlinked components at the OS
		// layer. Anchor on realpath(projectDir), which the caller supplies, and
		// compare the target's real parent against it.
		// The trailing separator matters: a bare startsWith(root) would leave a
		// sibling directory named `sqlite-evil` deletable.
		const { realpath, rm } = await import("node:fs/promises");
		const projectRoot = await realpath(opts.projectDir).catch(() => null);
		if (projectRoot === null) return;

		const root = join(projectRoot, ".launchfile", "data", "sqlite");
		const target = resolve(projectRoot, state.dbName);
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
