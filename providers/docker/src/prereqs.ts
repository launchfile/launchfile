/**
 * Prerequisite checks for the Docker provider.
 */

import { shellOk, shell } from "./shell.js";

export interface PrereqResult {
	ok: boolean;
	missing: string[];
}

export async function checkPrereqs(): Promise<PrereqResult> {
	const missing: string[] = [];

	if (!(await shellOk("which", ["docker"]))) {
		missing.push("Docker — install from https://docs.docker.com/get-docker/");
		return { ok: false, missing };
	}

	// Check Docker daemon is running
	if (!(await shellOk("docker", ["info"]))) {
		missing.push("Docker daemon is not running — start Docker Desktop or run: sudo systemctl start docker");
		return { ok: false, missing };
	}

	// Check docker compose v2 plugin
	const composeCheck = await shell("docker", ["compose", "version"], { allowFailure: true, silent: true });
	if (composeCheck.exitCode !== 0) {
		missing.push("Docker Compose v2 plugin — install from https://docs.docker.com/compose/install/");
	}

	return { ok: missing.length === 0, missing };
}

/**
 * Parse a `docker compose version --short` string (e.g. "2.39.1" or
 * "v2.18.0") and report whether it is at least major.minor. Unparseable
 * versions return false — callers fall back to the conservative path.
 * Exported for unit testing.
 */
export function composeVersionAtLeast(version: string, major: number, minor: number): boolean {
	const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
	if (!m) return false;
	const maj = Number(m[1]);
	const min = Number(m[2]);
	return maj > major || (maj === major && min >= minor);
}

/**
 * `docker compose pull --ignore-buildable` requires Compose >= 2.18 (2023).
 * On older installs the unknown flag aborts the pull outright, so callers
 * must choose a fallback instead of passing it blindly.
 */
export async function composeSupportsIgnoreBuildable(): Promise<boolean> {
	const result = await shell("docker", ["compose", "version", "--short"], {
		allowFailure: true,
		silent: true,
	});
	if (result.exitCode !== 0) return false;
	return composeVersionAtLeast(result.stdout, 2, 18);
}
