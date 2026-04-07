/**
 * SQLite resource provisioner — just creates a directory for the DB file.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedRequirement } from "@launchfile/sdk";
import type { ResourceState } from "../state.js";
import type { ProvisionOpts, ResourceProperties, ResourceProvisioner } from "./types.js";

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

		const properties: ResourceProperties = {
			url: `sqlite://${dbPath}`,
			host: "",
			port: 0,
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

	async destroy(state: ResourceState): Promise<void> {
		if (state.dbName) {
			const { rm } = await import("node:fs/promises");
			await rm(state.dbName, { force: true });
		}
	}
}
