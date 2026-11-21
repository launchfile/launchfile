#!/usr/bin/env node
/**
 * Fail when bun.lock's record of internal workspace packages differs from the
 * package.json files it was generated from.
 *
 * `bun install --frozen-lockfile` only proves the lockfile is self-consistent.
 * The lockfile also records each workspace member's own `version` and the
 * ranges of its internal (workspace-to-workspace) dependencies. This script
 * compares those recorded values against the declared ones. It compares; it
 * never installs, so it needs no network and no bun.
 *
 * Usage:
 *   node scripts/lint-lockfile-ranges.mjs [rootDir]   # default: cwd
 *
 * Exit codes: 0 clean, 1 drift found, 2 the linter could not run (unreadable
 * or unparseable input, or no internal ranges found to check).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** Thrown for input the linter cannot interpret; never reported as a pass. */
export class LintError extends Error {}

function readJson(path, { trailingCommas = false } = {}) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		throw new LintError(`cannot read ${path}: ${err.message}`);
	}
	// bun.lock is JSON with trailing commas before } and ].
	if (trailingCommas) text = text.replace(/,(\s*[}\]])/g, "$1");
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new LintError(`cannot parse ${path}: ${err.message}`);
	}
}

/** Expands the root `workspaces` globs ("dir" and "dir/*") to member directories. */
function workspaceDirs(rootDir, globs) {
	const dirs = [];
	for (const glob of globs) {
		if (glob.endsWith("/*")) {
			const base = glob.slice(0, -2);
			const baseAbs = join(rootDir, base);
			if (!existsSync(baseAbs)) continue;
			for (const entry of readdirSync(baseAbs, { withFileTypes: true })) {
				if (entry.isDirectory() && existsSync(join(baseAbs, entry.name, "package.json"))) {
					dirs.push(`${base}/${entry.name}`);
				}
			}
		} else if (glob.includes("*")) {
			throw new LintError(`unsupported workspace glob "${glob}" (only "dir" and "dir/*")`);
		} else if (existsSync(join(rootDir, glob, "package.json"))) {
			dirs.push(glob);
		}
	}
	return dirs.sort();
}

function internalRanges(manifest, internal) {
	const out = new Map();
	for (const field of DEP_FIELDS) {
		for (const [name, range] of Object.entries(manifest[field] ?? {})) {
			if (internal.has(name)) out.set(`${field}:${name}`, { name, range });
		}
	}
	return out;
}

/** Returns { failures: string[], checked: number } for the repo at rootDir. */
export function lintLockfileRanges(rootDir) {
	const rootManifest = readJson(join(rootDir, "package.json"));
	const globs = Array.isArray(rootManifest.workspaces)
		? rootManifest.workspaces
		: rootManifest.workspaces?.packages;
	if (!Array.isArray(globs) || globs.length === 0) {
		throw new LintError(`${join(rootDir, "package.json")} declares no workspaces`);
	}
	const lock = readJson(join(rootDir, "bun.lock"), { trailingCommas: true });
	const recordedWorkspaces = lock.workspaces;
	if (!recordedWorkspaces || typeof recordedWorkspaces !== "object") {
		throw new LintError("bun.lock has no `workspaces` section");
	}

	const members = workspaceDirs(rootDir, globs).map((dir) => ({
		dir,
		manifest: readJson(join(rootDir, dir, "package.json")),
	}));
	const internal = new Set(members.map((m) => m.manifest.name).filter(Boolean));

	const failures = [];
	let checked = 0;

	for (const { dir, manifest } of members) {
		const recorded = recordedWorkspaces[dir];
		if (!recorded) {
			failures.push(`${dir}: workspace member is missing from bun.lock`);
			continue;
		}
		if (recorded.version !== manifest.version) {
			failures.push(
				`${dir}: version recorded ${recorded.version ?? "(none)"}, declared ${manifest.version ?? "(none)"}`,
			);
		}
		const declared = internalRanges(manifest, internal);
		const seen = internalRanges(recorded, internal);
		for (const [key, d] of declared) {
			checked++;
			const r = seen.get(key);
			if (!r) {
				failures.push(`${dir}: ${d.name} declared ${d.range} in ${key.split(":")[0]}, not recorded`);
			} else if (r.range !== d.range) {
				failures.push(`${dir}: ${d.name} recorded ${r.range}, declared ${d.range}`);
			}
		}
		for (const [key, r] of seen) {
			if (!declared.has(key)) {
				failures.push(`${dir}: ${r.name} recorded ${r.range} in ${key.split(":")[0]}, not declared`);
			}
		}
	}

	for (const path of Object.keys(recordedWorkspaces)) {
		if (path !== "" && !members.some((m) => m.dir === path)) {
			failures.push(`${path}: recorded in bun.lock but matches no workspace in package.json`);
		}
	}

	if (checked === 0 && failures.length === 0) {
		throw new LintError("found no internal dependency ranges to check; refusing to pass vacuously");
	}
	return { failures, checked };
}

function main() {
	const rootDir = process.argv[2] ?? process.cwd();
	try {
		const { failures, checked } = lintLockfileRanges(rootDir);
		if (failures.length > 0) {
			process.stderr.write(`bun.lock disagrees with package.json (${failures.length}):\n`);
			for (const f of failures) process.stderr.write(`  ${f}\n`);
			process.stderr.write("Run `bun install` at the repo root and commit bun.lock.\n");
			process.exit(1);
		}
		process.stdout.write(`bun.lock internal ranges match package.json (${checked} checked)\n`);
	} catch (err) {
		if (!(err instanceof LintError)) throw err;
		process.stderr.write(`lint-lockfile-ranges: ${err.message}\n`);
		process.exit(2);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
