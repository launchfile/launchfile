/**
 * `launchfile up [target]` — Start an app locally.
 */

import { resolve } from "node:path";
import { dockerUp, UnsuppliedRequiredEnvError } from "@launchfile/docker";
import { isLaunchError } from "@launchfile/sdk";
import { detectProvider } from "../detect-provider.js";
import { resolveUpTarget } from "../resolve-target.js";
import { clearLaunchErrorRecord, writeLaunchErrorRecord } from "../state/errors.js";
import {
	loadIndex,
	addDeployment,
	updateDeployment,
	findBySource,
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

		let result: Awaited<ReturnType<typeof dockerUp>>;
		try {
			result = await withFailureRecord(() =>
				dockerUp(dockerSource, {
					detach: flags.detach,
					dryRun: flags.dryRun,
				}),
			);
		} catch (err) {
			// An unsupplied `required:` variable (D-52) is an operator's problem to
			// fix, not a bug — it gets the provider's own message, not a stack trace.
			if (err instanceof UnsuppliedRequiredEnvError) {
				console.error(`\n${err.message}`);
				process.exit(1);
			}
			throw err;
		}

		// Retention (#44 §H): the previous failure record for this key described a
		// launch that no longer exists. Supersede it rather than leaving stale log
		// tails on disk for `diagnose` to present as current.
		if (!flags.dryRun) await clearLaunchErrorRecord(result.slug);

		if (!flags.dryRun) {
			// Identity (#48): key the index entry by the SAME slug the docker
			// provider stores its state under, derived from the Launchfile
			// `name:`. Using the provider's slug here (instead of the directory
			// basename via inferAppName) keeps `up` and `bootstrap`/`down` in
			// agreement when the project dir name != Launchfile `name:`.
			const entry: DeploymentEntry = {
				appName: result.slug,
				slug: result.slug,
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
		// The import is what "provider not available" describes, so only the
		// import is caught here. Wrapping the launch in the same try reported
		// every genuine launch failure — a failed Postgres provision, a failed
		// release — as a missing npm package, which `diagnose` cannot correct.
		const { launchUp } = await loadMacosProvider();

		const projectDir = upTarget.dir ?? process.cwd();
		await withFailureRecord(() =>
			launchUp({ projectDir, dryRun: flags.dryRun, detach: flags.detach }),
		);

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
	}
}

/** Load the optional native provider, or explain how to install it and stop. */
async function loadMacosProvider(): Promise<typeof import("@launchfile/macos-dev")> {
	try {
		return await import("@launchfile/macos-dev");
	} catch (err) {
		console.error("macOS native provider not available.");
		console.error("Install: npm install -g @launchfile/macos-dev");
		console.error(`Error: ${(err as Error).message}`);
		process.exit(1);
	}
}

/**
 * Persist the structured context of a launch failure, then re-throw (#44).
 *
 * The provider builds and redacts the context inside the failing process, where
 * its secret registry is still live; this only writes what it was handed. A
 * failure carrying no context — anything not a `LaunchError` — propagates
 * unchanged rather than being recorded as a guess.
 */
export async function withFailureRecord<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (isLaunchError(err)) {
			await writeLaunchErrorRecord(err.context).catch(() => undefined);
			console.error("\n  Captured. Run `launchfile diagnose` for the full context.");
		}
		throw err;
	}
}

function inferAppName(source: string): string {
	// Try to extract from path (parent dir name or Launchfile name field)
	const parts = source.replace(/\/Launchfile$/, "").split("/");
	return parts[parts.length - 1] ?? "app";
}
