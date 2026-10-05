/**
 * Confined writes under the project directory.
 *
 * `.launchfile/` ships inside the cloned repository, so every path under it
 * is repo-controlled: a committed symlink at `.launchfile`, `.launchfile/env`
 * or `.launchfile/state.json` would send the provider's writes — state with
 * database passwords, env files with secrets, component logs — wherever the
 * link points (CWE-59). `mkdir({ recursive: true })` and `writeFile` both
 * follow such a link and report nothing.
 *
 * The project root is the one path the caller vouches for, so it is the only
 * anchor: `realpath(projectDir)` is resolved once, and the requested path is
 * joined onto it lexically and never resolved itself. Resolving both ends
 * would pass a symlinked component through, since both sides then agree on
 * the link's target. A project directory that itself sits under a symlink
 * (`/tmp` → `/private/tmp`) is fine: the anchor is its real path.
 *
 * Only paths under the project directory are confined here. A volume marked
 * `content: operator` keeps the verbatim path the operator supplied (D-50)
 * and never comes through this module.
 */

import {
	chmod,
	constants,
	type FileHandle,
	lstat,
	mkdir,
	open,
	readlink,
	realpath,
} from "node:fs/promises";
import { join, sep } from "node:path";

/**
 * A write the provider refuses because the path cannot be trusted. `message`
 * is the operator-facing line: the offending path, what was found there, and
 * that nothing was written.
 */
export class ConfinementRefusal extends Error {
	readonly path: string;
	readonly reason: string;

	constructor(path: string, reason: string) {
		super(`${path} ${reason}; refusing to write`);
		this.name = "ConfinementRefusal";
		this.path = path;
		this.reason = reason;
	}
}

export interface ConfinedDirOpts {
	/** Applied on creation and again with `chmod`, so an existing directory is tightened too. */
	mode: number;
}

export interface ConfinedFileOpts {
	/** Applied on creation and again with `fchmod`, so an existing file is tightened too. */
	mode: number;
	/** Mode for a parent directory this call creates or tightens. Defaults to `0o700`. */
	dirMode?: number;
	/** Open for appending rather than truncating. */
	append?: boolean;
}

/** `realpath(projectDir)`, or a refusal when the project directory is not there. */
async function anchor(projectDir: string): Promise<string> {
	const root = await realpath(projectDir).catch(() => null);
	if (root === null) {
		throw new ConfinementRefusal(projectDir, "does not exist");
	}
	return root;
}

/**
 * Lexical containment with the separator included, so a sibling whose name
 * merely starts with the root's (`.launchfile-evil`) does not pass.
 */
function isUnder(path: string, root: string): boolean {
	return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function describeLink(path: string): Promise<string> {
	const target = await readlink(path).catch(() => null);
	return target === null ? "is a symlink" : `is a symlink to ${target}`;
}

/**
 * Creates `<realpath(projectDir)>/<...parts>` and returns that path, refusing
 * when any component is a symlink or something other than a directory.
 *
 * Each component is `lstat`ed (which does not follow links) before anything
 * is created — `realpath` cannot do this check, as the path does not exist on
 * a first run. After the `mkdir` the directory must still resolve to itself:
 * that catches a link planted between the check and the create. The mode is
 * applied on creation and again with `chmod`, because `mkdir` applies its
 * mode only to a directory it creates (CWE-276).
 */
export async function ensureConfinedDir(
	projectDir: string,
	parts: readonly string[],
	opts: ConfinedDirOpts,
): Promise<string> {
	const root = await anchor(projectDir);
	const path = join(root, ...parts);
	if (!isUnder(path, root)) {
		throw new ConfinementRefusal(path, `is outside ${root}`);
	}
	let current = root;
	for (const component of parts) {
		current = join(current, component);
		const entry = await lstat(current).catch(() => null);
		if (entry === null) continue;
		if (entry.isSymbolicLink()) {
			throw new ConfinementRefusal(current, await describeLink(current));
		}
		if (!entry.isDirectory()) {
			throw new ConfinementRefusal(current, "is not a directory");
		}
	}
	await mkdir(path, { recursive: true, mode: opts.mode });
	await chmod(path, opts.mode);
	const real = await realpath(path).catch(() => null);
	if (real !== path) {
		throw new ConfinementRefusal(path, `resolves to ${real ?? "nothing"}`);
	}
	return path;
}

/**
 * Opens `<realpath(projectDir)>/<...parts>` for writing, creating it if
 * absent, and returns the handle. The parent directory goes through
 * {@link ensureConfinedDir} first unless it is the project root itself,
 * which is the anchor and is never created or chmodded here. The file is
 * opened with `O_NOFOLLOW`, so a symlink in its place fails with `ELOOP` and
 * is refused rather than written through. The caller closes the handle.
 */
export async function openConfinedFile(
	projectDir: string,
	parts: readonly string[],
	opts: ConfinedFileOpts,
): Promise<FileHandle> {
	const parentParts = parts.slice(0, -1);
	const parent =
		parentParts.length > 0
			? await ensureConfinedDir(projectDir, parentParts, {
					mode: opts.dirMode ?? 0o700,
				})
			: await anchor(projectDir);
	const path = join(parent, ...parts.slice(-1));
	if (!isUnder(path, parent)) {
		throw new ConfinementRefusal(path, `is outside ${parent}`);
	}
	const { O_WRONLY, O_CREAT, O_TRUNC, O_APPEND, O_NOFOLLOW } = constants;
	const flags =
		O_WRONLY | O_CREAT | O_NOFOLLOW | (opts.append ? O_APPEND : O_TRUNC);
	let handle: FileHandle;
	try {
		handle = await open(path, flags, opts.mode);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ELOOP") {
			throw new ConfinementRefusal(path, await describeLink(path));
		}
		throw err;
	}
	try {
		// `open` applies the mode only to a file it creates; a file left by an
		// earlier run keeps its old mode otherwise (CWE-276).
		await handle.chmod(opts.mode);
	} catch (err) {
		await handle.close();
		throw err;
	}
	return handle;
}

/**
 * Writes `data` to `<realpath(projectDir)>/<...parts>`, replacing any
 * content, through {@link openConfinedFile}.
 */
export async function writeConfinedFile(
	projectDir: string,
	parts: readonly string[],
	data: string,
	opts: Omit<ConfinedFileOpts, "append">,
): Promise<void> {
	const handle = await openConfinedFile(projectDir, parts, opts);
	try {
		await handle.writeFile(data);
	} finally {
		await handle.close();
	}
}
