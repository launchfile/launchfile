/**
 * State management for the Docker provider.
 *
 * State lives at ~/.launchfile/docker/{slug}/ so apps are
 * isolated and state persists across runs.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export interface DockerState {
	version: 1;
	slug: string;
	appName: string;
	composeProject: string;
	launchfileHash: string;
	createdAt: string;
	updatedAt: string;
	secrets: Record<string, string>;
	ports: Record<string, number>;
}

export function stateBaseDir(): string {
	return join(homedir(), ".launchfile", "docker");
}

export function stateDir(slug: string): string {
	return join(stateBaseDir(), slug);
}

function statePath(slug: string): string {
	return join(stateDir(slug), "state.json");
}

export function composePath(slug: string): string {
	return join(stateDir(slug), "docker-compose.yml");
}

export function composeProject(slug: string): string {
	return `launchfile-${slug}`;
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export async function loadState(slug: string): Promise<DockerState | null> {
	try {
		const raw = await readFile(statePath(slug), "utf8");
		return JSON.parse(raw) as DockerState;
	} catch {
		return null;
	}
}

export function initState(slug: string, appName: string, launchfileContent: string): DockerState {
	const now = new Date().toISOString();
	return {
		version: 1,
		slug,
		appName,
		composeProject: composeProject(slug),
		launchfileHash: hashContent(launchfileContent),
		createdAt: now,
		updatedAt: now,
		secrets: {},
		ports: {},
	};
}

export async function saveState(slug: string, state: DockerState): Promise<void> {
	state.updatedAt = new Date().toISOString();
	// Security: restrict directory/file permissions — state.json contains
	// database passwords and generated secrets in plaintext.
	await mkdir(stateDir(slug), { recursive: true, mode: 0o700 });
	await writeFile(statePath(slug), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export async function ensureStateDir(slug: string): Promise<void> {
	await mkdir(stateDir(slug), { recursive: true, mode: 0o700 });
}
