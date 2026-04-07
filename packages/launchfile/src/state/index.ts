/**
 * Deployment index manager.
 *
 * Maintains ~/.launchfile/deployments/index.json as the single source
 * of truth for all managed deployments.
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

export function deploymentDir(id: string): string {
	return join(deploymentsDir(), id);
}

function indexPath(): string {
	return join(deploymentsDir(), "index.json");
}

function emptyIndex(): DeploymentIndex {
	return { version: 1, deployments: {} };
}

export async function loadIndex(): Promise<DeploymentIndex> {
	try {
		const raw = await readFile(indexPath(), "utf8");
		return JSON.parse(raw) as DeploymentIndex;
	} catch {
		return emptyIndex();
	}
}

export async function saveIndex(index: DeploymentIndex): Promise<void> {
	await mkdir(deploymentsDir(), { recursive: true });
	await writeFile(indexPath(), JSON.stringify(index, null, 2) + "\n");
}

export async function addDeployment(
	id: string,
	entry: DeploymentEntry,
): Promise<void> {
	const index = await loadIndex();
	index.deployments[id] = entry;
	await saveIndex(index);
	await mkdir(deploymentDir(id), { recursive: true });
}

export async function updateDeployment(
	id: string,
	updates: Partial<DeploymentEntry>,
): Promise<void> {
	const index = await loadIndex();
	const existing = index.deployments[id];
	if (!existing) return;
	index.deployments[id] = { ...existing, ...updates, updatedAt: new Date().toISOString() };
	await saveIndex(index);
}

export async function removeDeployment(id: string): Promise<void> {
	const index = await loadIndex();
	delete index.deployments[id];
	await saveIndex(index);
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

/** Find the deployment for the current working directory */
export function findBySource(
	index: DeploymentIndex,
	sourcePath: string,
): { id: string; entry: DeploymentEntry } | null {
	for (const [id, entry] of Object.entries(index.deployments)) {
		if (entry.source === sourcePath) {
			return { id, entry };
		}
	}
	return null;
}
