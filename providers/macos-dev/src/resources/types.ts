/**
 * Resource provisioner interface.
 *
 * Each resource type (postgres, redis, etc.) implements this interface
 * to handle install, start, database creation, and teardown.
 */

import type { NormalizedRequirement } from "@launchfile/sdk";
import type { shell, shellOk } from "../shell.js";
import type { ResourceState } from "../state.js";

/**
 * Properties that a provisioned resource exposes for expression resolution.
 *
 * Only `url` is required. A resource type addressed by something other than a
 * network endpoint — sqlite is a file — has no host and no port, and fabricating
 * `host: ""` / `port: 0` to satisfy the type would report a value an app could
 * act on (PROVIDERS.md §10.8, D-52). Omitted properties resolve to the empty
 * string through the standard unknown-property rule, so leaving them out costs
 * the caller nothing.
 */
export interface ResourceProperties {
	url: string;
	host?: string;
	port?: number;
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

/**
 * The shell surface a provisioner runs against. Injecting it lets tests drive
 * the provisioning sequence without Homebrew or a live server.
 */
export interface ShellRunner {
	shell: typeof shell;
	shellOk: typeof shellOk;
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
