/**
 * Detect the package manager from lockfile presence.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";

export interface PackageManager {
	name: string;
	installCommand: string;
	lockfile: string;
}

const LOCKFILE_ORDER: PackageManager[] = [
	{ name: "bun", installCommand: "bun install", lockfile: "bun.lockb" },
	{ name: "bun", installCommand: "bun install", lockfile: "bun.lock" },
	{ name: "pnpm", installCommand: "pnpm install", lockfile: "pnpm-lock.yaml" },
	{ name: "yarn", installCommand: "yarn install", lockfile: "yarn.lock" },
	{ name: "npm", installCommand: "npm install", lockfile: "package-lock.json" },
	{ name: "bundler", installCommand: "bundle install", lockfile: "Gemfile.lock" },
	{ name: "go", installCommand: "go mod download", lockfile: "go.sum" },
	{ name: "cargo", installCommand: "cargo build", lockfile: "Cargo.lock" },
	{ name: "pip", installCommand: "pip install -r requirements.txt", lockfile: "requirements.txt" },
	{ name: "poetry", installCommand: "poetry install", lockfile: "poetry.lock" },
	{ name: "uv", installCommand: "uv sync", lockfile: "uv.lock" },
];

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Detect the package manager from lockfile presence in a directory.
 * Returns the first match in priority order, or null.
 */
export async function detectPackageManager(projectDir: string): Promise<PackageManager | null> {
	for (const pm of LOCKFILE_ORDER) {
		if (await fileExists(join(projectDir, pm.lockfile))) {
			return pm;
		}
	}
	return null;
}
