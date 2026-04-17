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
