/**
 * Redis resource provisioner via Homebrew.
 */

import type { NormalizedRequirement } from "@launchfile/sdk";
import { shell, shellOk } from "../shell.js";
import type { ResourceState } from "../state.js";
import type { ProvisionOpts, ResourceProperties, ResourceProvisioner } from "./types.js";

const DEFAULT_PORT = 6379;
const DEFAULT_HOST = "localhost";

export class RedisProvisioner implements ResourceProvisioner {
	readonly type = "redis";

	async isRunning(): Promise<boolean> {
		return shellOk("redis-cli ping");
	}

	async provision(
		req: NormalizedRequirement,
		_opts: ProvisionOpts,
		_existingState?: ResourceState,
	): Promise<{ properties: ResourceProperties; state: ResourceState }> {
		if (!(await this.isRunning())) {
			console.log("  Starting Redis via brew...");
			const started = await shellOk("brew services start redis");
			if (!started) {
				await shell("brew install redis");
				await shell("brew services start redis");
			}
		}

		const port = DEFAULT_PORT;
		const resourceName = req.name ?? req.type;

		const properties: ResourceProperties = {
			url: `redis://${DEFAULT_HOST}:${port}/0`,
			host: DEFAULT_HOST,
			port,
			password: "",
		};

		const state: ResourceState = {
			type: "redis",
			name: resourceName,
			brewService: "redis",
			port,
		};

		return { properties, state };
	}

	async destroy(_state: ResourceState): Promise<void> {
		// Redis is shared, don't stop the service
		// Could flush a specific database prefix, but not worth the complexity
	}
}
