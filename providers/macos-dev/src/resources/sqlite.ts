/**
 * SQLite resource provisioner — just creates a directory for the DB file.
 */

import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
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
		// so dbName is untrusted here. provision() puts the file under
		// .launchfile/data/sqlite/; anything else is refused, not deleted.
		// The trailing separator matters: a bare startsWith(root) would leave a
		// sibling directory named `sqlite-evil` deletable.
		const root = resolve(
			join(opts.projectDir, ".launchfile", "data", "sqlite"),
		);
		const target = resolve(state.dbName);
		if (!target.startsWith(root + sep)) {
			console.warn(
				`  ! sqlite: refusing to delete ${target} — outside ${root}`,
			);
			return;
		}

		const { rm } = await import("node:fs/promises");
		await rm(target, { force: true });
	}
}
