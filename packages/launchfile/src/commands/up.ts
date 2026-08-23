/**
 * `launchfile up [target]` — Start an app locally.
 */

import { resolve } from "node:path";
import {
	dockerUp,
	type DockerUpOpts,
	type DockerUpResult,
	UnsuppliedRequiredEnvError,
} from "@launchfile/docker";
import { isLaunchError, type LaunchPhase } from "@launchfile/sdk";
import { detectProvider } from "../detect-provider.js";
import { resolveUpTarget } from "../resolve-target.js";
import {
	clearLaunchErrorRecord,
	errorsDir,
	writeLaunchErrorRecord,
} from "../state/errors.js";
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

/**
 * Collaborators the command owns, injected so the failure paths are testable
 * without docker and without writing to the real `~/.launchfile` (the repo's
 * injection-over-module-mocking rule). The CLI passes none of them.
 */
export interface UpDeps {
	/** Runs the docker launch. */
	up?: (source: string, opts: DockerUpOpts) => Promise<DockerUpResult>;
	/** Imports the optional native provider. */
	importMacos?: () => Promise<typeof import("@launchfile/macos-dev")>;
	/** Deployment index directory. */
	indexDir?: string;
	/** Failure-record directory. */
	recordDir?: string;
}

/**
 * The index status for a deployment whose launch failed in `phase`, or null when
 * the launch was refused before anything started.
 *
 * The index says what exists, not what succeeded. From `release` onwards a
 * deployment is on the machine: a release runs one-shot containers that bring
 * their `depends_on` resources up first, `run` starts the app services, and the
 * health gate deliberately leaves everything running for inspection. In all
 * three cases `status`, `logs`, and `down` must reach it — including the
 * `launchfile status / launchfile logs` the health failure itself prints.
 *
 * The earlier phases (`prereq`, `resolve`, `parse`, `provision`, `prepare`) stop
 * before a container exists, so they leave no entry: an index row for a
 * deployment that was never started is the same lie in the other direction.
 */
export function failedDeploymentStatus(
	phase: LaunchPhase,
): DeploymentEntry["status"] | null {
	switch (phase) {
		case "health":
			// Containers are up and the gate never passed. That is exactly "unhealthy".
			return "unhealthy";
		case "release":
		case "run":
			// Some containers exist; which ones survived the failure is not knowable
			// from here without asking docker again on an already-failing path.
			return "unknown";
		default:
			return null;
	}
}

export async function handleUp(
	target: string | undefined,
	flags: UpFlags,
	deps: UpDeps = {},
): Promise<void> {
	const upTarget = resolveUpTarget(target);
	const provider = await detectProvider({ docker: flags.docker, native: flags.native });
	const indexDir = deps.indexDir;
	const recordDir = deps.recordDir ?? errorsDir();

	// Determine source key for index lookup
	const sourceKey = upTarget.type === "local"
		? upTarget.dir ?? resolve(upTarget.value, "..")
		: `catalog:${upTarget.value}`;

	// Check for existing deployment
	const index = await loadIndex(indexDir);
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

	/** Write this run's index row, creating it or refreshing the existing one. */
	const record = async (
		entry: Omit<DeploymentEntry, "name" | "port" | "createdAt" | "updatedAt">,
	): Promise<void> => {
		const full: DeploymentEntry = {
			...entry,
			name: flags.name ?? existingDeployment?.entry.name ?? null,
			port: null, // TODO: extract from Docker provider result
			createdAt: existingDeployment?.entry.createdAt ?? new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		if (existingDeployment) {
			await updateDeployment(deployId, full, indexDir);
		} else {
			await addDeployment(deployId, full, indexDir);
		}
	};

	if (provider === "docker") {
		// Resolve the source string for the Docker provider
		const dockerSource = upTarget.type === "local"
			? upTarget.value
			: upTarget.value;

		const launch = deps.up ?? dockerUp;
		let result: DockerUpResult;
		try {
			result = await withFailureRecord(
				() =>
					launch(dockerSource, {
						detach: flags.detach,
						dryRun: flags.dryRun,
					}),
				recordDir,
			);
		} catch (err) {
			// An unsupplied `required:` variable (D-52) is an operator's problem to
			// fix, not a bug — it gets the provider's own message, not a stack trace.
			if (err instanceof UnsuppliedRequiredEnvError) {
				console.error(`\n${err.message}`);
				process.exit(1);
			}
			// The launch failed, but containers may be running. Register the
			// deployment before re-throwing so the remediation the failure prints
			// resolves — `up` still exits non-zero, carrying the LaunchError.
			if (!flags.dryRun && isLaunchError(err)) {
				const status = failedDeploymentStatus(err.context.phase);
				const slug = err.context.slug;
				if (status && slug) {
					// Identity matches the success path: appName is the provider slug.
					await record({
						appName: slug,
						slug,
						provider: "docker",
						source: sourceKey,
						sourceType: upTarget.type,
						status,
					});
					console.error(
						`  Deployment ${deployId} is recorded as ${status} — \`launchfile down\` removes it.`,
					);
				}
			}
			throw err;
		}

		// Retention (#44 §H): the previous failure record for this key described a
		// launch that no longer exists. Supersede it rather than leaving stale log
		// tails on disk for `diagnose` to present as current.
		if (!flags.dryRun) await clearLaunchErrorRecord(result.slug, recordDir);

		if (!flags.dryRun) {
			// Identity (#48): key the index entry by the SAME slug the docker
			// provider stores its state under, derived from the Launchfile
			// `name:`. Using the provider's slug here (instead of the directory
			// basename via inferAppName) keeps `up` and `bootstrap`/`down` in
			// agreement when the project dir name != Launchfile `name:`.
			await record({
				appName: result.slug,
				slug: result.slug,
				provider: "docker",
				source: sourceKey,
				sourceType: upTarget.type,
				status: "up",
			});

			console.log(`\n  Deployment: ${deployId}`);
		}
	} else if (provider === "macos") {
		// The import is what "provider not available" describes, so only the
		// import is caught here. Wrapping the launch in the same try reported
		// every genuine launch failure — a failed Postgres provision, a failed
		// release — as a missing npm package, which `diagnose` cannot correct.
		const { launchUp } = await loadMacosProvider(deps.importMacos);

		const projectDir = upTarget.dir ?? process.cwd();
		await withFailureRecord(
			() => launchUp({ projectDir, dryRun: flags.dryRun, detach: flags.detach }),
			recordDir,
		);

		if (!flags.dryRun) {
			await record({
				appName: inferAppName(upTarget.value),
				provider: "macos",
				source: sourceKey,
				sourceType: upTarget.type,
				status: "up",
			});

			console.log(`\n  Deployment: ${deployId}`);
		}
	}
}

/** Load the optional native provider, or explain how to install it and stop. */
export async function loadMacosProvider(
	importMacos: () => Promise<typeof import("@launchfile/macos-dev")> = () =>
		import("@launchfile/macos-dev"),
): Promise<typeof import("@launchfile/macos-dev")> {
	try {
		return await importMacos();
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
export async function withFailureRecord<T>(
	run: () => Promise<T>,
	dir: string = errorsDir(),
): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (isLaunchError(err)) {
			await writeLaunchErrorRecord(err.context, dir).catch(() => undefined);
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
