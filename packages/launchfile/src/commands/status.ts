/**
 * `launchfile status [target]` — Show deployment status.
 */

import { dockerStatus } from "@launchfile/docker";
import { resolveDeploymentTarget } from "../resolve-target.js";

export async function handleStatus(target: string | undefined): Promise<void> {
	const deployment = await resolveDeploymentTarget(target);

	if (deployment.entry.provider === "docker") {
		const slug = deployment.entry.sourceType === "catalog"
			? deployment.entry.source.replace("catalog:", "")
			: deployment.entry.appName;
		await dockerStatus(slug);
	} else if (deployment.entry.provider === "macos") {
		try {
			const { launchStatus } = await import("@launchfile/macos-dev");
			await launchStatus({ projectDir: deployment.entry.source });
		} catch (err) {
			console.error(`Error: ${(err as Error).message}`);
			process.exit(1);
		}
	}
}
