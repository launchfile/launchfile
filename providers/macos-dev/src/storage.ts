/**
 * Local storage provisioning for Launchfile volumes.
 *
 * Maps named volumes to local directories under .launchfile/, and exposes the
 * resolved local path per volume so the provider can inject it as
 * `$storage.<name>.path` (D-39).
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StorageVolume } from "@launchfile/sdk";

const STATE_DIR = ".launchfile";

/**
 * Compute the local path this provider uses for each of a component's storage
 * volumes — keyed by **volume name** (the `storage:` key), which is what
 * `$storage.<name>.path` resolves against (D-39). Pure: no filesystem side
 * effects, so callers that only need the resolved paths (e.g. `launchfile env`)
 * can use it without provisioning. Persistent volumes live under
 * `.launchfile/storage/<component>/<name>`; ephemeral ones under `.../tmp/...`.
 */
export function storagePaths(
	storage: Record<string, StorageVolume> | undefined,
	componentName: string,
	projectDir: string,
): Record<string, string> {
	if (!storage) return {};

	const volumeMap: Record<string, string> = {};
	for (const [name, volume] of Object.entries(storage)) {
		const persistent = volume.persistent !== false; // default true
		const subdir = persistent ? "storage" : "tmp";
		volumeMap[name] = join(projectDir, STATE_DIR, subdir, componentName, name);
	}
	return volumeMap;
}

/**
 * Create the local directories for a component's storage volumes and return the
 * volume-name → local-path map (the home-#3 value the resolver injects as
 * `$storage.<name>.path`, D-39). Previously the return was keyed by container
 * path and discarded at the call site — the path is now captured and delivered.
 */
export async function provisionStorage(
	storage: Record<string, StorageVolume> | undefined,
	componentName: string,
	projectDir: string,
): Promise<Record<string, string>> {
	const volumeMap = storagePaths(storage, componentName, projectDir);
	for (const localPath of Object.values(volumeMap)) {
		await mkdir(localPath, { recursive: true });
	}
	return volumeMap;
}

/** Clean up ephemeral (non-persistent) storage for a component */
export async function cleanEphemeralStorage(
	storage: Record<string, StorageVolume> | undefined,
	componentName: string,
	projectDir: string,
): Promise<void> {
	if (!storage) return;

	for (const [name, volume] of Object.entries(storage)) {
		if (volume.persistent === false) {
			const localPath = join(projectDir, STATE_DIR, "tmp", componentName, name);
			await rm(localPath, { recursive: true, force: true });
		}
	}
}

/** Clean up all storage (persistent + ephemeral) for a component */
export async function destroyStorage(
	componentName: string,
	projectDir: string,
): Promise<void> {
	await rm(join(projectDir, STATE_DIR, "storage", componentName), {
		recursive: true,
		force: true,
	});
	await rm(join(projectDir, STATE_DIR, "tmp", componentName), {
		recursive: true,
		force: true,
	});
}
