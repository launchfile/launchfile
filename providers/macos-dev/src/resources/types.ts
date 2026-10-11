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
	/**
	 * The names of the entry's named `database` uses (SPEC.md § Resource
	 * uses), pooled across same-name entries. A SQL provisioner creates one
	 * more database per name beside the app's — `<instance>_<name>` — and
	 * records them in state so `destroy` drops them. Other provisioners
	 * ignore it.
	 */
	databases?: readonly string[];
	/**
	 * Called with the resource's state record before the provisioner creates
	 * any credential-bearing object (a role or user). The record must be
	 * readable as `existingState` by the next `provision()`, so a throw after
	 * the object exists cannot lose the password it was created with.
	 */
	persist?: (state: ResourceState) => Promise<void>;
}

/**
 * The trusted context a teardown runs in. `state.json` is repo-supplied and
 * parsed without validation (`state.ts`), so a provisioner cannot treat a
 * stored path or identifier as its own; `projectDir` comes from the caller and
 * is the only trustworthy boundary a destroy can confine itself to.
 */
export interface DestroyOpts {
	projectDir: string;
}

export interface ProvisionResult {
	properties: ResourceProperties;
	state: ResourceState;
	warnings: string[];
}

/**
 * Thrown by `provision()` when the resource cannot be handed out safely — a
 * repo-controlled path the provisioner refuses to write through, for one.
 * The provisioner prints the reason before throwing, so the caller records
 * the refusal, provisions what remains, and exits non-zero naming every
 * refused resource. Any other error still aborts the run.
 */
export class ResourceRefusedError extends Error {
	constructor(
		readonly resourceName: string,
		readonly reason: string,
	) {
		super(`${resourceName}: ${reason}`);
		this.name = "ResourceRefusedError";
	}
}

export interface ResourceProvisioner {
	readonly type: string;

	/** Check if the service is already running */
	isRunning(): Promise<boolean>;

	/**
	 * Ensure the service is installed and running, create app-specific
	 * resources. `warnings` carries every gap the provisioner found in the
	 * entry it was given — a `requires[].version` it cannot show is met
	 * (PROVIDERS.md §10 item 8) — for the caller to print.
	 */
	provision(
		req: NormalizedRequirement,
		opts: ProvisionOpts,
		existingState?: ResourceState,
	): Promise<ProvisionResult>;

	/** Drop app-specific databases/users (destroy mode) */
	destroy(state: ResourceState, opts: DestroyOpts): Promise<void>;
}
