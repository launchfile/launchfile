#!/usr/bin/env bun
/**
 * check-linked-exports — fail when a package in .changeset/config.json's
 * `linked` array has no `exports` map in its package.json.
 *
 * `linked` is the set of packages released together to npm (RELEASING.md →
 * "Packages"). An `exports` map is what stops a consumer from deep-importing
 * `dist/*` files, so each of those packages must declare one.
 *
 * Runs as part of sdk's `pretest` hook, so `bun run test` and CI's existing
 * `sdk` job both exercise it with no separate wiring.
 *
 * Usage: bun run scripts/check-linked-exports.ts [repo-root]
 *   repo-root defaults to the monorepo root (the parent of sdk/).
 *
 * Exit codes: 0 every linked package declares exports, 1 at least one does
 * not, 2 the check itself could not run (unreadable config, a linked name
 * with no workspace package).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

interface PackageJson {
	name?: string;
	exports?: unknown;
	workspaces?: string[];
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/** Expand the root `workspaces` entries ("sdk", "providers/*") to package dirs. */
function workspaceDirs(root: string, patterns: string[]): string[] {
	const dirs: string[] = [];
	for (const pattern of patterns) {
		if (pattern.endsWith("/*")) {
			const parent = join(root, pattern.slice(0, -2));
			if (!existsSync(parent)) continue;
			for (const entry of readdirSync(parent, { withFileTypes: true })) {
				if (entry.isDirectory()) dirs.push(join(parent, entry.name));
			}
		} else {
			dirs.push(join(root, pattern));
		}
	}
	return dirs.filter((dir) => existsSync(join(dir, "package.json")));
}

function main(): void {
	const root = resolve(
		process.argv[2] ?? join(import.meta.dirname, "..", ".."),
	);

	let linked: string[];
	let packagesByName: Map<string, { dir: string; pkg: PackageJson }>;
	try {
		const config = readJson<{ linked?: string[][] }>(
			join(root, ".changeset", "config.json"),
		);
		linked = (config.linked ?? []).flat();
		const rootPkg = readJson<PackageJson>(join(root, "package.json"));
		packagesByName = new Map();
		for (const dir of workspaceDirs(root, rootPkg.workspaces ?? [])) {
			const pkg = readJson<PackageJson>(join(dir, "package.json"));
			if (pkg.name) packagesByName.set(pkg.name, { dir, pkg });
		}
	} catch (err) {
		console.error(
			`✗ linked exports check could not run: ${(err as Error).message}`,
		);
		process.exit(2);
	}

	if (linked.length === 0) {
		console.error(
			"✗ linked exports check could not run: .changeset/config.json has no `linked` packages.",
		);
		process.exit(2);
	}

	const unknown = linked.filter((name) => !packagesByName.has(name));
	if (unknown.length > 0) {
		console.error(
			`✗ linked exports check could not run: .changeset/config.json links ${unknown.map((n) => `"${n}"`).join(", ")}, which no workspace package.json names.`,
		);
		process.exit(2);
	}

	const missing = linked.filter((name) => {
		const exports = packagesByName.get(name)?.pkg.exports;
		return exports === undefined || exports === null;
	});
	if (missing.length > 0) {
		console.error("\n✗ linked exports check failed:\n");
		for (const name of missing) {
			const dir = packagesByName.get(name)?.dir ?? name;
			console.error(
				`  - ${name} (${relative(root, join(dir, "package.json"))}) has no "exports" map.`,
			);
		}
		console.error(
			'\nEvery package in .changeset/config.json\'s "linked" array ships to npm and must declare "exports" (with "types" before "import").\n',
		);
		process.exit(1);
	}

	console.log(
		`✓ linked exports: ${linked.length} linked packages, all declare "exports".`,
	);
}

main();
