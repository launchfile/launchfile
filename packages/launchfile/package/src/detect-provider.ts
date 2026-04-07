/**
 * Auto-detect which provider to use.
 *
 * Priority: explicit flag → Docker (if available) → macOS native → error.
 */

import { execFile } from "node:child_process";

export type ProviderName = "docker" | "macos";

async function isDockerAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("docker", ["info"], { timeout: 5000 }, (error) => {
			resolve(!error);
		});
	});
}

export async function detectProvider(flags: {
	docker?: boolean;
	native?: boolean;
}): Promise<ProviderName> {
	if (flags.docker) return "docker";
	if (flags.native) return "macos";

	if (await isDockerAvailable()) return "docker";

	if (process.platform === "darwin") return "macos";

	console.error("No provider available.");
	console.error("  Install Docker: https://docs.docker.com/get-docker/");
	console.error("  Or use --native on macOS (requires Homebrew).");
	process.exit(1);
}
