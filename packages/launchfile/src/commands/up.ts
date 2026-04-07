/**
 * `launchfile up [target]` — Start an app locally.
 */

import { resolve } from "node:path";
import { dockerUp } from "@launchfile/docker";
import { detectProvider } from "../detect-provider.js";
import { resolveUpTarget } from "../resolve-target.js";
import {
	loadIndex,
	addDeployment,
	updateDeployment,
	findBySource,
	deploymentDir,
	generateDeploymentId,
	type DeploymentEntry,
} from "../state/index.js";

export interface UpFlags {
	docker?: boolean;
	native?: boolean;
	detach?: boolean;
	dryRun?: boolean;
	name?: string;
}

export async function handleUp(target: string | undefined, flags: UpFlags): Promise<void> {
	const upTarget = resolveUpTarget(target);
	const provider = await detectProvider({ docker: flags.docker, native: flags.native });

	// Determine source key for index lookup
	const sourceKey = upTarget.type === "local"
		? upTarget.dir ?? resolve(upTarget.value, "..")
		: `catalog:${upTarget.value}`;

	// Check for existing deployment
	const index = await loadIndex();
	let existingDeployment = findBySource(index, sourceKey);

	// For named deployments, check for name conflicts
	if (flags.name) {
		const nameConflict = Object.entries(index.deployments).find(
			([, e]) => e.name === flags.name,
		);
		if (nameConflict && existingDeployment?.id !== nameConflict[0]) {
			// Different deployment already uses this name — create new
			existingDeployment = null;
		}
	}

	const deployId = existingDeployment?.id ?? generateDeploymentId();

	if (provider === "docker") {
		// Resolve the source string for the Docker provider
		const dockerSource = upTarget.type === "local"
			? upTarget.value
			: upTarget.value;

		await dockerUp(dockerSource, {
			detach: flags.detach,
			dryRun: flags.dryRun,
		});

		if (!flags.dryRun) {
			// Register/update in index
			const entry: DeploymentEntry = {
				appName: upTarget.type === "catalog" ? upTarget.value : inferAppName(upTarget.value),
				provider: "docker",
				source: sourceKey,
				sourceType: upTarget.type,
				name: flags.name ?? existingDeployment?.entry.name ?? null,
				port: null, // TODO: extract from Docker provider result
				status: "up",
				createdAt: existingDeployment?.entry.createdAt ?? new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};

			if (existingDeployment) {
				await updateDeployment(deployId, entry);
			} else {
				await addDeployment(deployId, entry);
			}

			console.log(`\n  Deployment: ${deployId}`);
		}
	} else if (provider === "macos") {
		// macOS native provider
		try {
			const { launchUp } = await import("@launchfile/macos-dev");
			const projectDir = upTarget.dir ?? process.cwd();
			await launchUp({ projectDir, dryRun: flags.dryRun, detach: flags.detach });

			if (!flags.dryRun) {
				const entry: DeploymentEntry = {
					appName: inferAppName(upTarget.value),
					provider: "macos",
					source: sourceKey,
					sourceType: upTarget.type,
					name: flags.name ?? null,
					port: null,
					status: "up",
					createdAt: existingDeployment?.entry.createdAt ?? new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};

				if (existingDeployment) {
					await updateDeployment(deployId, entry);
				} else {
					await addDeployment(deployId, entry);
				}

				console.log(`\n  Deployment: ${deployId}`);
			}
		} catch (err) {
			console.error("macOS native provider not available.");
			console.error("Install: npm install -g @launchfile/macos-dev");
			console.error(`Error: ${(err as Error).message}`);
			process.exit(1);
		}
	}
}

function inferAppName(source: string): string {
	// Try to extract from path (parent dir name or Launchfile name field)
	const parts = source.replace(/\/Launchfile$/, "").split("/");
	return parts[parts.length - 1] ?? "app";
}
