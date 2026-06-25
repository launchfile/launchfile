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
	status: "up" | "down" | "unknown";
	createdAt: string;
	updatedAt: string;
}

export interface DeploymentIndex {
	version: 1;
	deployments: Record<string, DeploymentEntry>;
}
