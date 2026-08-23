/**
 * Persistence for structured launch failures (#44).
 *
 * ```
 * ~/.launchfile/errors/<key>.json   one record per app key
 * ~/.launchfile/errors/last.json    { key, path, timestamp } — written LAST
 * ```
 *
 * One record **per key**, not one global file. Concurrent deploys are a
 * supported case — PROVIDERS.md §9 calls out worktree deployments getting
 * distinct ports (UC3) — and a single shared file would have two failing `up`
 * runs racing each other, with the loser's diagnosis silently gone.
 *
 * The pointer exists because pre-deploy failures (`prereq`, `resolve`, `parse`)
 * happen before a deployment index entry is written: `handleUp` generates the
 * deployment id up front but only records it after success, so a failed run
 * leaves nothing to look the key up by. `last.json` makes a bare
 * `launchfile diagnose` work regardless. It is written last so a crash mid-write
 * leaves the previous pointer readable rather than a truncated one.
 *
 * Everything written here is already redacted: the provider scrubs at capture,
 * in the process that still holds the secret registry. This module never sees an
 * unredacted string and could not scrub one if it did.
 *
 * Every entry point takes the directory as a defaulted argument so tests can
 * point it at a temp directory (the repo's injection-over-module-mocking rule).
 * There is deliberately **no** environment variable for it: an unvalidated path
 * knob is CWE-22, and no caller in the CLI passes anything but the default.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type LaunchErrorContext, parseLaunchErrorContext } from "@launchfile/sdk";

/** Records hold command output and log tails — same treatment as a state file. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Pointer to the most recent failure, for a bare `launchfile diagnose`. */
export interface LastErrorPointer {
	version: 1;
	key: string;
	path: string;
	timestamp: string;
}

export function errorsDir(): string {
	return join(homedir(), ".launchfile", "errors");
}

/**
 * Reduce a provider-supplied key to one path segment.
 *
 * The key comes from a slug or a content hash, but it reaches this module as an
 * ordinary string, and it is about to become a filename. Anything outside the
 * safe set becomes `_`, so no key can traverse out of the errors directory
 * (CWE-22). The length cap keeps the result a legal filename on every platform.
 */
export function safeKey(key: string): string {
	const cleaned = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
	// A key of only dots would name the directory itself or its parent.
	return /^\.+$/.test(cleaned) || cleaned === "" ? "_" : cleaned;
}

export function errorRecordPath(key: string, dir: string = errorsDir()): string {
	return join(dir, `${safeKey(key)}.json`);
}

export function lastPointerPath(dir: string = errorsDir()): string {
	return join(dir, "last.json");
}

/** Write `data` at `path` with a restrictive mode, atomically. */
async function writeAtomic(path: string, data: string): Promise<void> {
	const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	await writeFile(temp, data, { mode: FILE_MODE });
	await rename(temp, path);
}

/** Create the errors directory, and fix its mode if it already exists too open. */
async function ensureErrorsDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: DIR_MODE });
	// `mkdir` sets the mode only when it creates the directory. Setting it
	// unconditionally means a directory created by an earlier version, or under a
	// looser umask, does not stay world-readable (CWE-276).
	await chmod(dir, DIR_MODE);
}

/**
 * Persist one failure record and repoint `last.json` at it. Returns the record's
 * path. The pointer is written after the record, never before.
 */
export async function writeLaunchErrorRecord(
	context: LaunchErrorContext,
	dir: string = errorsDir(),
): Promise<string> {
	await ensureErrorsDir(dir);
	const path = errorRecordPath(context.key, dir);
	await writeAtomic(path, `${JSON.stringify(context, null, 2)}\n`);

	const pointer: LastErrorPointer = {
		version: 1,
		key: context.key,
		path,
		timestamp: context.timestamp,
	};
	await writeAtomic(lastPointerPath(dir), `${JSON.stringify(pointer, null, 2)}\n`);
	return path;
}

async function readJson(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return null;
	}
}

/** The `last.json` pointer, or null when nothing has failed yet. */
export async function readLastPointer(
	dir: string = errorsDir(),
): Promise<LastErrorPointer | null> {
	const raw = await readJson(lastPointerPath(dir));
	if (typeof raw !== "object" || raw === null) return null;
	const pointer = raw as Partial<LastErrorPointer>;
	if (pointer.version !== 1 || typeof pointer.key !== "string") return null;
	return {
		version: 1,
		key: pointer.key,
		path:
			typeof pointer.path === "string" ? pointer.path : errorRecordPath(pointer.key, dir),
		timestamp: typeof pointer.timestamp === "string" ? pointer.timestamp : "",
	};
}

/**
 * Read the record for `key`, or the most recent one when `key` is omitted.
 * Returns null when there is no record, or when the file on disk is not a
 * launch-error record — a reader never trusts the file's shape.
 */
export async function readLaunchErrorRecord(
	key?: string,
	dir: string = errorsDir(),
): Promise<LaunchErrorContext | null> {
	const resolved = key ?? (await readLastPointer(dir))?.key;
	if (!resolved) return null;
	return parseLaunchErrorContext(await readJson(errorRecordPath(resolved, dir)));
}

/**
 * Drop the record for `key`, and the pointer if it named that key.
 *
 * Retention (§H): a record holding redacted-but-still-sensitive log tails must
 * not outlive its relevance. A successful `up` for the same key supersedes it,
 * and `down --destroy` removes it along with the rest of the app's state.
 */
export async function clearLaunchErrorRecord(
	key: string,
	dir: string = errorsDir(),
): Promise<void> {
	await rm(errorRecordPath(key, dir), { force: true });
	const pointer = await readLastPointer(dir);
	if (pointer?.key === key) {
		await rm(lastPointerPath(dir), { force: true });
	}
}
