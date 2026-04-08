/**
 * Resolves a source argument (slug, path, or URL) to Launchfile YAML.
 *
 * Supported inputs:
 * - "ghost" → fetch from GitHub catalog
 * - "./Launchfile" or "/path/to/Launchfile" → read from disk
 * - "https://..." → fetch from URL
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface ResolvedSource {
	yaml: string;
	slug: string;
	source: "local" | "catalog" | "url";
}

// Security: cap remote Launchfile size to prevent memory exhaustion.
// No legitimate Launchfile should approach this limit.
const MAX_REMOTE_SIZE = 256 * 1024; // 256 KB

const CATALOG_RAW_BASE =
	"https://raw.githubusercontent.com/launchfile/launchfile/main/catalog";

/** Slug pattern: lowercase letters, digits, hyphens — no slashes or dots */
const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export async function resolveSource(input: string): Promise<ResolvedSource> {
	// URL — starts with http:// or https://
	if (input.startsWith("http://") || input.startsWith("https://")) {
		return fetchFromUrl(input);
	}

	// Local path — contains a slash or dot, or the file exists
	if (input.includes("/") || input.includes(".") || existsSync(resolve(input))) {
		return readLocal(input);
	}

	// Catalog slug
	if (SLUG_PATTERN.test(input)) {
		return fetchFromCatalog(input);
	}

	throw new Error(
		`Cannot resolve "${input}". Expected a catalog slug (e.g., "ghost"), a file path, or a URL.`,
	);
}

async function readLocal(path: string): Promise<ResolvedSource> {
	const resolved = resolve(path);
	const yaml = await readFile(resolved, "utf8");
	const slug = inferSlug(resolved, yaml);
	return { yaml, slug, source: "local" };
}

/**
 * Find local catalog directory (exists in the monorepo, not when published).
 * Layout: providers/docker/src/ → ../../../catalog
 */
function findLocalCatalog(): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidate = join(here, "..", "..", "..", "catalog");
	return existsSync(candidate) ? candidate : null;
}

async function fetchFromCatalog(slug: string): Promise<ResolvedSource> {
	// Try local catalog first (monorepo / development)
	const localCatalog = findLocalCatalog();
	if (localCatalog) {
		for (const dir of ["apps", "drafts"]) {
			const path = join(localCatalog, dir, slug, "Launchfile");
			if (existsSync(path)) {
				const yaml = await readFile(path, "utf8");
				return { yaml, slug, source: "catalog" };
			}
		}
	}

	// Fall back to remote catalog (GitHub)
	for (const dir of ["apps", "drafts"]) {
		const url = `${CATALOG_RAW_BASE}/${dir}/${slug}/Launchfile`;
		const response = await fetch(url);
		if (response.ok) {
			const yaml = await response.text();
			if (yaml.length > MAX_REMOTE_SIZE) {
				throw new Error(`Catalog Launchfile "${slug}" exceeds maximum size (${MAX_REMOTE_SIZE} bytes)`);
			}
			return { yaml, slug, source: "catalog" };
		}
	}

	throw new Error(
		`App "${slug}" not found in the Launchfile catalog. Browse available apps at https://launchfile.io/apps/`,
	);
}

async function fetchFromUrl(url: string): Promise<ResolvedSource> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch Launchfile from ${url}: ${response.status} ${response.statusText}`);
	}

	const yaml = await response.text();
	if (yaml.length > MAX_REMOTE_SIZE) {
		throw new Error(`Remote Launchfile exceeds maximum size (${MAX_REMOTE_SIZE} bytes)`);
	}
	const slug = inferSlugFromUrl(url, yaml);
	return { yaml, slug, source: "url" };
}

function inferSlug(filePath: string, yaml: string): string {
	// Try to extract name from YAML content
	const nameMatch = yaml.match(/^name:\s*(.+)$/m);
	if (nameMatch?.[1]) {
		return nameMatch[1].trim().replace(/['"]/g, "");
	}
	// Fall back to parent directory name
	const dir = basename(resolve(filePath, ".."));
	return dir === "." ? "app" : dir;
}

function inferSlugFromUrl(url: string, yaml: string): string {
	// Try to extract from URL path (e.g., /apps/ghost/Launchfile)
	const pathMatch = url.match(/\/apps\/([a-z][a-z0-9-]*)(?:\/|$)/);
	if (pathMatch?.[1]) {
		return pathMatch[1];
	}
	// Fall back to YAML name
	return inferSlug(url, yaml);
}
