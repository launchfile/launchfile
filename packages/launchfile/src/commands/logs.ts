/**
 * `launchfile logs [target]` — View deployment logs.
 */

import { dockerLogs } from "@launchfile/docker";
import { resolveDeploymentTarget } from "../resolve-target.js";

export interface LogsFlags {
	follow?: boolean;
}

export async function handleLogs(target: string | undefined, flags: LogsFlags): Promise<void> {
	const deployment = await resolveDeploymentTarget(target);

	if (deployment.entry.provider === "docker") {
		const slug = deployment.entry.sourceType === "catalog"
			? deployment.entry.source.replace("catalog:", "")
			: deployment.entry.appName;
		await dockerLogs({ follow: flags.follow, slug });
	} else if (deployment.entry.provider === "macos") {
		console.error("Logs are not yet supported for the macOS native provider.");
		process.exit(1);
	}
}
