/**
 * Unified deployment state types.
 */

export interface DeploymentEntry {
	appName: string;
	provider: "docker" | "macos";
	source: string;
	sourceType: "local" | "catalog" | "url";
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
