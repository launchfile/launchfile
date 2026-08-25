/**
 * Deployment index manager.
 *
 * Maintains ~/.launchfile/deployments/index.json as the single source
 * of truth for all managed deployments.
 *
 * The index states what exists on the machine, not what succeeded: a launch that
 * started containers and then failed still has a deployment, and `status`,
 * `logs`, and `down` all resolve through here (`commands/up.ts` →
 * `failedDeploymentStatus`).
 *
 * Every entry point takes the directory as a defaulted argument so tests can
 * point it at a temp directory (the repo's injection-over-module-mocking rule).
 * As in `state/errors.ts`, there is deliberately no environment variable for it.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DeploymentIndex, DeploymentEntry } from "./types.js";

export type { DeploymentEntry, DeploymentIndex } from "./types.js";
export { generateDeploymentId } from "./deployment-id.js";

function launchfileHome(): string {
	return join(homedir(), ".launchfile");
}

export function deploymentsDir(): string {
	return join(launchfileHome(), "deployments");
}

export function deploymentDir(id: string, dir: string = deploymentsDir()): string {
	return join(dir, id);
}

function indexPath(dir: string): string {
	return join(dir, "index.json");
}

function emptyIndex(): DeploymentIndex {
	return { version: 1, deployments: {} };
}

export async function loadIndex(
	dir: string = deploymentsDir(),
): Promise<DeploymentIndex> {
	try {
		const raw = await readFile(indexPath(dir), "utf8");
		return JSON.parse(raw) as DeploymentIndex;
	} catch {
		return emptyIndex();
	}
}

export async function saveIndex(
	index: DeploymentIndex,
	dir: string = deploymentsDir(),
): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(indexPath(dir), JSON.stringify(index, null, 2) + "\n");
}

export async function addDeployment(
	id: string,
	entry: DeploymentEntry,
	dir: string = deploymentsDir(),
): Promise<void> {
	const index = await loadIndex(dir);
	index.deployments[id] = entry;
	await saveIndex(index, dir);
	await mkdir(deploymentDir(id, dir), { recursive: true });
}

export async function updateDeployment(
	id: string,
	updates: Partial<DeploymentEntry>,
	dir: string = deploymentsDir(),
): Promise<void> {
	const index = await loadIndex(dir);
	const existing = index.deployments[id];
	if (!existing) return;
	index.deployments[id] = { ...existing, ...updates, updatedAt: new Date().toISOString() };
	await saveIndex(index, dir);
}

export async function removeDeployment(
	id: string,
	dir: string = deploymentsDir(),
): Promise<void> {
	const index = await loadIndex(dir);
	delete index.deployments[id];
	await saveIndex(index, dir);
}

/**
 * The slug the docker provider keyed its state under for this deployment (#48).
 * Prefer the persisted `slug` (written at `up` time, identical to the
 * provider's `inferSlug` result). Older index entries lack it — fall back to
 * the legacy derivation: catalog source → slug after the `catalog:` prefix,
 * otherwise the stored `appName`.
 */
export function dockerSlugFor(entry: DeploymentEntry): string {
	if (entry.slug) return entry.slug;
	return entry.sourceType === "catalog"
		? entry.source.replace("catalog:", "")
		: entry.appName;
}

/** Find a deployment by ID, name, app slug, or source directory */
export function findDeployment(
	index: DeploymentIndex,
	query: string,
): { id: string; entry: DeploymentEntry }[] {
	const results: { id: string; entry: DeploymentEntry }[] = [];

	for (const [id, entry] of Object.entries(index.deployments)) {
		// Match by deployment ID
		if (id === query) {
			return [{ id, entry }];
		}
		// Match by user-assigned name
		if (entry.name === query) {
			results.push({ id, entry });
		}
		// Match by app name
		if (entry.appName === query) {
			results.push({ id, entry });
		}
	}

	return results;
}

/**
 * Find the deployment for the current working directory.
 *
 * `name` narrows the match to one instance (D-55): a deployment's identity is
 * the (source, name) pair, so an unnamed `up` (`name: null`) never resolves to
 * a named instance from the same directory, and vice versa. Omitting `name`
 * keeps the legacy any-instance behavior — first match wins — for callers that
 * only have a path.
 */
export function findBySource(
	index: DeploymentIndex,
	sourcePath: string,
	name?: string | null,
): { id: string; entry: DeploymentEntry } | null {
	for (const { id, entry } of findAllBySource(index, sourcePath)) {
		if (name === undefined || (entry.name ?? null) === name) {
			return { id, entry };
		}
	}
	return null;
}

/** Every deployment launched from `sourcePath`, one per instance name (D-55). */
export function findAllBySource(
	index: DeploymentIndex,
	sourcePath: string,
): { id: string; entry: DeploymentEntry }[] {
	const results: { id: string; entry: DeploymentEntry }[] = [];
	for (const [id, entry] of Object.entries(index.deployments)) {
		if (entry.source === sourcePath) {
			results.push({ id, entry });
		}
	}
	return results;
}
