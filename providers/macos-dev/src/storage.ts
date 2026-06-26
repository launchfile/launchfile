/**
 * Local storage provisioning for Launchfile volumes.
 *
 * Maps container paths to local directories under .launchfile/.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StorageVolume } from "@launchfile/sdk";

const STATE_DIR = ".launchfile";

/**
 * Create local directories for a component's storage volumes.
 * Returns a map of container path → local path.
 */
export async function provisionStorage(
	storage: Record<string, StorageVolume> | undefined,
	componentName: string,
	projectDir: string,
): Promise<Record<string, string>> {
	if (!storage) return {};

	const volumeMap: Record<string, string> = {};

	for (const [name, volume] of Object.entries(storage)) {
		const persistent = volume.persistent !== false; // default true
		const subdir = persistent ? "storage" : "tmp";
		const localPath = join(projectDir, STATE_DIR, subdir, componentName, name);

		await mkdir(localPath, { recursive: true });
		volumeMap[volume.path] = localPath;
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
