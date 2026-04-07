/**
 * Resource provisioner interface.
 *
 * Each resource type (postgres, redis, etc.) implements this interface
 * to handle install, start, database creation, and teardown.
 */

import type { NormalizedRequirement } from "@launchfile/sdk";
import type { ResourceState } from "../state.js";

/** Properties that a provisioned resource exposes for expression resolution */
export interface ResourceProperties {
	url: string;
	host: string;
	port: number;
	user?: string;
	password?: string;
	name?: string;
	path?: string;
	access_key?: string;
	secret_key?: string;
	bucket?: string;
	region?: string;
	[key: string]: string | number | undefined;
}

export interface ProvisionOpts {
	appName: string;
	projectDir: string;
}

export interface ResourceProvisioner {
	readonly type: string;

	/** Check if the service is already running */
	isRunning(): Promise<boolean>;

	/** Ensure the service is installed and running, create app-specific resources */
	provision(
		req: NormalizedRequirement,
		opts: ProvisionOpts,
		existingState?: ResourceState,
	): Promise<{ properties: ResourceProperties; state: ResourceState }>;

	/** Drop app-specific databases/users (destroy mode) */
	destroy(state: ResourceState): Promise<void>;
}
