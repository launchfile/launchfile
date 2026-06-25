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

/** Where the Launchfile that produced this state came from. */
export type DockerSourceType = "local" | "catalog" | "url";

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
	/**
	 * Where the Launchfile came from, persisted so post-launch operations
	 * (bootstrap, inspect) can re-read it without depending on the caller's
	 * cwd (#25). Optional for backward compatibility — state files written by
	 * older versions lack these fields and must still load.
	 */
	sourceType?: DockerSourceType;
	/**
	 * Absolute path to the Launchfile on disk for `local` sources. Undefined
	 * for catalog/url sources (re-resolve from `slug`/`sourceUrl` instead).
	 */
	sourcePath?: string;
	/** Original URL for `url` sources, so it can be re-fetched. */
	sourceUrl?: string;
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

export interface InitStateSource {
	sourceType?: DockerSourceType;
	sourcePath?: string;
	sourceUrl?: string;
}

export function initState(
	slug: string,
	appName: string,
	launchfileContent: string,
	source: InitStateSource = {},
): DockerState {
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
		sourceType: source.sourceType,
		sourcePath: source.sourcePath,
		sourceUrl: source.sourceUrl,
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

/** Persisted source location for a deployed slug (#25). */
export interface DockerSourceInfo {
	slug: string;
	sourceType?: DockerSourceType;
	sourcePath?: string;
	sourceUrl?: string;
}

/**
 * Read the persisted source location for a slug so post-launch operations
 * (bootstrap, inspect) can re-resolve the Launchfile without depending on the
 * caller's cwd. Returns null when no state exists. Fields may be undefined for
 * state files written before source persistence landed — callers must fall
 * back gracefully (#25).
 */
export async function loadDockerSource(slug: string): Promise<DockerSourceInfo | null> {
	const state = await loadState(slug);
	if (!state) return null;
	return {
		slug: state.slug,
		sourceType: state.sourceType,
		sourcePath: state.sourcePath,
		sourceUrl: state.sourceUrl,
	};
}
