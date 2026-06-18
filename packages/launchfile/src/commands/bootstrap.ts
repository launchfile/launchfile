/**
 * `launchfile bootstrap [target] [--component <name>]` — Run a deployment's
 * commands.bootstrap stage (D-34) against the running component, capture
 * stdout against the declared patterns, and print results.
 *
 * Dispatches to the provider-specific implementation:
 * - docker:    dockerBootstrap from @launchfile/docker
 * - macos-dev: launchBootstrap from @launchfile/macos-dev
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dockerBootstrap, loadDockerSource } from "@launchfile/docker";
import { readLaunch } from "@launchfile/sdk";
import { resolveDeploymentTarget } from "../resolve-target.js";
import { dockerSlugFor, type DeploymentEntry } from "../state/index.js";

export interface BootstrapFlags {
	component?: string;
}

export async function handleBootstrap(
	target: string | undefined,
	flags: BootstrapFlags,
): Promise<void> {
	const deployment = await resolveDeploymentTarget(target);

	if (deployment.entry.provider === "docker") {
		// Identity (#48): use the same slug docker keyed its state under.
		const slug = dockerSlugFor(deployment.entry);

		// Source location (#25): prefer the path the docker provider persisted
		// at `up` time so we can re-read the Launchfile from anywhere. Fall back
		// to the legacy cwd/source guesses for state written before this landed.
		const launchfilePath = await resolveLaunchfilePath(slug, deployment.entry);

		let content: string;
		try {
			content = await readFile(launchfilePath, "utf-8");
		} catch (err) {
			console.error(
				`Error: could not read Launchfile at ${launchfilePath}. ` +
				`Run \`launchfile bootstrap\` from the directory containing the Launchfile, ` +
				`or specify the deployment target explicitly.`,
			);
			console.error(`  Underlying error: ${(err as Error).message}`);
			process.exit(1);
		}

		const launch = readLaunch(content);

		const results = await dockerBootstrap({
			launch,
			slug,
			component: flags.component,
		});

		if (results.length === 0) process.exit(0);
		const anyFailed = results.some((r) => !r.ok);
		process.exit(anyFailed ? 1 : 0);
	}

	if (deployment.entry.provider === "macos") {
		try {
			const { launchBootstrap } = await import("@launchfile/macos-dev");
			const results = await launchBootstrap({
				projectDir: deployment.entry.source,
				component: flags.component,
			});
			if (results.length === 0) process.exit(0);
			const anyFailed = results.some((r) => !r.ok);
			process.exit(anyFailed ? 1 : 0);
		} catch (err) {
			console.error(`Error: ${(err as Error).message}`);
			process.exit(1);
		}
	}

	console.error(`Unsupported provider: ${deployment.entry.provider}`);
	process.exit(1);
}

/**
 * Locate the Launchfile to re-read for a docker deployment (#25).
 *
 * 1. Persisted `sourcePath` from docker state (local sources) — works from
 *    any cwd. This is the path the provider recorded at `up` time.
 * 2. Legacy fallbacks for state written before source persistence:
 *    - local source → `<source>/Launchfile`
 *    - catalog/url  → `<cwd>/Launchfile` (best effort; the user must be cd'd
 *      into a checkout, matching the previous behavior).
 */
async function resolveLaunchfilePath(
	slug: string,
	entry: DeploymentEntry,
): Promise<string> {
	const persisted = await loadDockerSource(slug);
	if (persisted?.sourcePath) return persisted.sourcePath;

	if (entry.sourceType === "local") {
		return join(entry.source, "Launchfile");
	}
	return join(process.cwd(), "Launchfile");
}
