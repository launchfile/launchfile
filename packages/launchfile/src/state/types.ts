/**
 * Unified deployment state types.
 */

export interface DeploymentEntry {
	appName: string;
	provider: "docker" | "macos";
	source: string;
	sourceType: "local" | "catalog" | "url";
	/**
	 * Provider state key (#48). For docker this is the slug the provider
	 * derives from the Launchfile `name:` field — the SAME key docker uses to
	 * store/look up its own state. Persisted at `up` time so `bootstrap`/`down`
	 * look state up by an identity that matches the provider's, rather than
	 * re-deriving from the directory basename (which diverges when the project
	 * dir name != the Launchfile `name:`). Optional for backward compatibility
	 * — older index entries lack it and fall back to `appName`.
	 */
	slug?: string;
	name: string | null;
	port: number | null;
	/**
	 * What is on the machine, not whether the command succeeded.
	 *
	 * `unhealthy` is a deployment whose containers run and whose health gate
	 * never passed — `up` exited non-zero and left them up on purpose. `unknown`
	 * is a launch interrupted after containers started (a `release` or `run`
	 * failure), where some exist and the exact set is not knowable from here.
	 * Both are reachable by `status`, `logs`, and `down`.
	 */
	status: "up" | "down" | "unhealthy" | "unknown";
	createdAt: string;
	updatedAt: string;
}

export interface DeploymentIndex {
	version: 1;
	deployments: Record<string, DeploymentEntry>;
}
