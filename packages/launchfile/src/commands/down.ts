/**
 * `launchfile down [target]` — Stop a deployment.
 */

import { dockerDown } from "@launchfile/docker";
import { resolveDeploymentTarget } from "../resolve-target.js";
import { updateDeployment, removeDeployment, deploymentDir } from "../state/index.js";

export interface DownFlags {
	destroy?: boolean;
}

export async function handleDown(target: string | undefined, flags: DownFlags): Promise<void> {
	const deployment = await resolveDeploymentTarget(target);

	if (deployment.entry.provider === "docker") {
		// Extract slug from source (catalog:ghost → ghost, or path → slug)
		const slug = deployment.entry.sourceType === "catalog"
			? deployment.entry.source.replace("catalog:", "")
			: deployment.entry.appName;

		await dockerDown({ destroy: flags.destroy, slug });

		if (flags.destroy) {
			// Remove from index and clean up deployment directory
			await removeDeployment(deployment.id);
			const { rm } = await import("node:fs/promises");
			await rm(deploymentDir(deployment.id), { recursive: true, force: true });
		} else {
			await updateDeployment(deployment.id, { status: "down" });
		}
	} else if (deployment.entry.provider === "macos") {
		try {
			const { launchDown } = await import("@launchfile/macos-dev");
			await launchDown({ destroy: flags.destroy, projectDir: deployment.entry.source });
			if (flags.destroy) {
				await removeDeployment(deployment.id);
			} else {
				await updateDeployment(deployment.id, { status: "down" });
			}
		} catch (err) {
			console.error(`Error: ${(err as Error).message}`);
			process.exit(1);
		}
	}
}
