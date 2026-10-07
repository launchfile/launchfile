/**
 * Filesystem primitives shared by the state modules.
 *
 * Everything under `~/.launchfile` can hold deployment detail — secrets,
 * command output, source paths — so every directory is owner-only and every
 * file is written owner-only, whatever was there before.
 */

import { chmod, mkdir, rename, writeFile } from "node:fs/promises";

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/**
 * Write `data` at `path` with a restrictive mode, atomically.
 *
 * `writeFile`'s `mode` reaches `open()`, which applies it only when the call
 * creates the file, so overwriting in place would leave a too-open file as it
 * was. Writing a fresh temp file and renaming it over the target lands a new
 * inode at the right mode every time, and a concurrent reader sees either the
 * old file or the new one, never a torn write.
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
	const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	await writeFile(temp, data, { mode: FILE_MODE });
	await rename(temp, path);
}

/** Create `dir` owner-only, and fix its mode if it already exists too open. */
export async function ensurePrivateDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: DIR_MODE });
	// `mkdir` sets the mode only when it creates the directory. Setting it
	// unconditionally means a directory created by an earlier version, or under a
	// looser umask, does not stay world-readable (CWE-276).
	await chmod(dir, DIR_MODE);
}
