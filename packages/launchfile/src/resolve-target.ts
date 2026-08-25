/**
 * Resolve a CLI target argument to either a Launchfile source (for `up`)
 * or a deployment entry (for `down`, `status`, `logs`).
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
	loadIndex,
	findDeployment,
	findBySource,
	findAllBySource,
	type DeploymentEntry,
} from "./state/index.js";

const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface UpTarget {
	type: "local" | "catalog" | "url";
	/** For local: absolute directory path. For catalog: slug. For URL: the URL. */
	value: string;
	/** Absolute path to the directory (for local sources) */
	dir?: string;
}

/**
 * Resolve the target for `launchfile up [target]`.
 * No target = use pwd (look for ./Launchfile).
 */
export function resolveUpTarget(target: string | undefined): UpTarget {
	// No target → look for ./Launchfile in pwd
	if (!target) {
		const cwd = process.cwd();
		const launchfilePath = resolve(cwd, "Launchfile");
		if (!existsSync(launchfilePath)) {
			console.error("No Launchfile found in the current directory.");
			console.error("Usage: launchfile up <slug|path>");
			console.error("  e.g.: launchfile up ghost");
			process.exit(1);
		}
		return { type: "local", value: launchfilePath, dir: cwd };
	}

	// URL
	if (target.startsWith("http://") || target.startsWith("https://")) {
		return { type: "url", value: target };
	}

	// Path (contains slash/dot or file exists)
	if (target.includes("/") || target.includes(".") || existsSync(resolve(target))) {
		const resolved = resolve(target);
		const dir = existsSync(resolved) && !resolved.endsWith("Launchfile")
			? resolved
			: resolve(resolved, "..");
		return { type: "local", value: resolved, dir };
	}

	// Catalog slug
	if (SLUG_PATTERN.test(target)) {
		return { type: "catalog", value: target };
	}

	console.error(`Cannot resolve "${target}".`);
	console.error("Expected a catalog slug (e.g., ghost), a file path, or a URL.");
	process.exit(1);
}

export interface ResolvedDeployment {
	id: string;
	entry: DeploymentEntry;
}

/**
 * Resolve the target for `launchfile down/status/logs [target]`.
 * No target = find by pwd. Otherwise: ID → name → slug (error if ambiguous).
 *
 * `dir` is the deployment index directory; tests pass a temp one. Every one of
 * those three commands funnels through here, so a deployment missing from the
 * index is a deployment none of them can reach.
 */
export async function resolveDeploymentTarget(
	target: string | undefined,
	dir?: string,
): Promise<ResolvedDeployment> {
	const index = await loadIndex(dir);

	// No target → find by pwd. Several instances can share one directory
	// (D-59: identity is the (source, name) pair), and picking one silently
	// would aim `down`/`status`/`logs` at an instance the user never named.
	if (!target) {
		const cwd = process.cwd();
		const found = findAllBySource(index, cwd);
		if (found.length === 1) return found[0]!;
		if (found.length > 1) exitAmbiguous(cwd, found);

		console.error("No deployment found for the current directory.");
		console.error("Specify a deployment ID or app name: launchfile down <id|name>");
		process.exit(1);
	}

	const matches = findDeployment(index, target);

	if (matches.length === 0) {
		// Maybe it's a pwd-based lookup for a path
		const resolved = resolve(target);
		const found = findBySource(index, resolved);
		if (found) return found;

		console.error(`No deployment found for "${target}".`);
		console.error("Run `launchfile list` to see active deployments.");
		process.exit(1);
	}

	if (matches.length === 1) {
		return matches[0]!;
	}

	// Ambiguous
	exitAmbiguous(target, matches);
}

function exitAmbiguous(
	query: string,
	matches: ResolvedDeployment[],
): never {
	console.error(`Multiple deployments match "${query}":`);
	for (const m of matches) {
		const src = m.entry.sourceType === "local"
			? m.entry.source.replace(process.env.HOME ?? "", "~")
			: m.entry.source;
		const name = m.entry.name ? `(--name ${m.entry.name})` : "(unnamed)";
		const port = m.entry.port ? `:${m.entry.port}` : "";
		console.error(`  ${m.id}  ${name}  ${src}  ${port}`);
	}
	console.error("\nSpecify a deployment ID or instance name.");
	process.exit(1);
}
