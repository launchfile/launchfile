/**
 * State management for the macOS dev provider.
 *
 * Persists secrets, ports, and resource state in .launchfile/state.json
 * so credentials and ports are stable across restarts.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface ResourceState {
	type: string;
	name: string;
	brewService?: string;
	port: number;
	dbName?: string;
	user?: string;
	password?: string;
}

export interface LaunchState {
	version: 1;
	appName: string;
	launchfileHash: string;
	createdAt: string;
	updatedAt: string;
	resources: Record<string, ResourceState>;
	secrets: Record<string, string>;
	ports: Record<string, number>;
}

const STATE_DIR = ".launchfile";
const STATE_FILE = "state.json";

function stateDir(projectDir: string): string {
	return join(projectDir, STATE_DIR);
}

function statePath(projectDir: string): string {
	return join(stateDir(projectDir), STATE_FILE);
}

export function hashLaunchfile(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Load state from disk, or return null if none exists */
export async function loadState(projectDir: string): Promise<LaunchState | null> {
	try {
		const raw = await readFile(statePath(projectDir), "utf8");
		return JSON.parse(raw) as LaunchState;
	} catch {
		return null;
	}
}

/** Create a fresh state object */
export function initState(appName: string, launchfileContent: string): LaunchState {
	const now = new Date().toISOString();
	return {
		version: 1,
		appName,
		launchfileHash: hashLaunchfile(launchfileContent),
		createdAt: now,
		updatedAt: now,
		resources: {},
		secrets: {},
		ports: {},
	};
}

/** Save state to disk */
export async function saveState(projectDir: string, state: LaunchState): Promise<void> {
	state.updatedAt = new Date().toISOString();
	// Security: restrict directory/file permissions — state.json contains
	// database passwords and generated secrets in plaintext.
	await mkdir(stateDir(projectDir), { recursive: true, mode: 0o700 });
	await writeFile(statePath(projectDir), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/** Ensure .launchfile directories exist */
export async function ensureDirs(projectDir: string): Promise<void> {
	const dirs = ["storage", "tmp", "logs", "data", "env"];
	// Security: restrict permissions — these dirs contain secrets, logs, env files
	await Promise.all(
		dirs.map((d) => mkdir(join(projectDir, STATE_DIR, d), { recursive: true, mode: 0o700 })),
	);
	// Safety net: write a .gitignore inside .launchfile/ so secrets aren't
	// accidentally committed even if the project's .gitignore doesn't exclude it.
	await writeFile(join(projectDir, STATE_DIR, ".gitignore"), "*\n", { mode: 0o644 });
}
