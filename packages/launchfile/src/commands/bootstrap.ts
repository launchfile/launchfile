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
import { dockerBootstrap } from "@launchfile/docker";
import { readLaunch } from "@launchfile/sdk";
import { resolveDeploymentTarget } from "../resolve-target.js";

export interface BootstrapFlags {
	component?: string;
}

export async function handleBootstrap(
	target: string | undefined,
	flags: BootstrapFlags,
): Promise<void> {
	const deployment = await resolveDeploymentTarget(target);

	if (deployment.entry.provider === "docker") {
		// Docker state only persists the composeProject, not the source. Read
		// the Launchfile from the catalog or the deployment's source path,
		// depending on how it was started.
		const launchfilePath = deployment.entry.sourceType === "catalog"
			? // We don't have a reliable way to find the catalog copy from
			  // here — fall back to re-reading the current working dir's
			  // Launchfile if the user invoked this from a catalog checkout.
			  join(process.cwd(), "Launchfile")
			: join(deployment.entry.source, "Launchfile");

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

		const slug = deployment.entry.sourceType === "catalog"
			? deployment.entry.source.replace("catalog:", "")
			: deployment.entry.appName;

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
