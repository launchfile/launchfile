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
 *
 * What this does not cover: the parent is verified (`lstat` per component,
 * then `realpath`) and the file is opened afterwards, as separate syscalls.
 * Node has no `openat` or `O_RESOLVE_BENEATH`, so a process that swaps a
 * verified parent for a symlink between those two calls is not caught. Such
 * a process needs write access to the project directory, which is the
 * operator's own access; the guard is against what the repository ships,
 * not against a concurrent local writer.
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
		const shown = printable(path);
		super(`${shown} ${reason}; refusing to write`);
		this.name = "ConfinementRefusal";
		this.path = shown;
		this.reason = reason;
	}
}

/**
 * Runs a command, turning a {@link ConfinementRefusal} into one
 * `Refused: <message>` line on stderr and exit 1, with no stack trace.
 * Anything else is rethrown unchanged.
 */
export async function withConfinementRefusal<T>(
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof ConfinementRefusal) {
			console.error(`Refused: ${err.message}`);
			process.exit(1);
		}
		throw err;
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
 * `<root>/<...parts>`, refusing any part that is not one plain path
 * component. The per-component `lstat` below and `O_NOFOLLOW` on open only
 * inspect the components they are handed: a part such as `env/web.env`
 * would let `env` be a symlink that neither check sees, and `..` would walk
 * out of the root before `join` reports anything.
 */
function confinedPath(root: string, parts: readonly string[]): string {
	for (const part of parts) {
		if (
			part === "" ||
			part === "." ||
			part === ".." ||
			part.includes(sep) ||
			part.includes("/")
		) {
			throw new ConfinementRefusal(part, "is not a single path component");
		}
	}
	return join(root, ...parts);
}

/** Escapes control characters in a repo-controlled string before it is printed (CWE-117). */
function printable(text: string): string {
	return Array.from(text, (c) => {
		if (c === "\\") return "\\\\";
		const code = c.charCodeAt(0);
		return code < 0x20 || (code >= 0x7f && code <= 0x9f)
			? `\\u${code.toString(16).padStart(4, "0")}`
			: c;
	}).join("");
}

async function describeLink(path: string): Promise<string> {
	const target = await readlink(path).catch(() => null);
	return target === null
		? "is a symlink"
		: `is a symlink to ${printable(target)}`;
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
	const path = confinedPath(root, parts);
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
		throw new ConfinementRefusal(
			path,
			`resolves to ${real === null ? "nothing" : printable(real)}`,
		);
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
	const path = confinedPath(parent, parts.slice(-1));
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
