#!/usr/bin/env bun
/**
 * Builds the catalog index from the directories themselves.
 *
 * Enumerates `catalog/apps/*` and `catalog/drafts/*` and rewrites the two app
 * tables in `catalog/README.md` between their `BEGIN GENERATED` / `END GENERATED`
 * markers. `test-all.ts` builds its tiers with `buildTiers` from here, so the
 * batch run covers the same set of directories.
 *
 * Column sources:
 *   Category    — `category:` in metadata.yaml
 *   Description — `tagline:` in metadata.yaml, else the Launchfile `description:`
 *   Services    — every `requires[].type` across all components
 *   Gaps        — `catalog/GAPS.md`: each open `### G-N:` heading's `**Apps**:` line,
 *                 display names matched to directory slugs
 *
 * Usage:
 *   bun run build-index            # rewrite catalog/README.md
 *   bun run build-index --check    # exit 1 if catalog/README.md is out of date
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { readLaunch } from "../../../sdk/src/reader.ts";

export type CatalogDir = "apps" | "drafts";

export interface CatalogEntry {
	slug: string;
	dir: CatalogDir;
	category: string | undefined;
	description: string | undefined;
	/** Backing-service types the app requires, sorted, without duplicates. */
	services: string[];
	componentCount: number;
}

/**
 * Requirement types that name something other than a backing service: the
 * public HTTPS origin (D-6) and host capabilities (D-44). The harness
 * provisions neither, so they appear in neither the Services column nor the tier.
 */
const NON_SERVICE_TYPES = new Set(["https-origin", "host"]);

export function readEntry(catalogRoot: string, dir: CatalogDir, slug: string): CatalogEntry {
	const base = join(catalogRoot, dir, slug);
	const launch = readLaunch(readFileSync(join(base, "Launchfile"), "utf-8"));
	const metaPath = join(base, "metadata.yaml");
	const meta: Record<string, unknown> = existsSync(metaPath)
		? ((parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown> | null) ?? {})
		: {};

	const components = Object.values(launch.components);
	const services = new Set<string>();
	for (const component of components) {
		for (const req of component.requires ?? []) {
			if (!NON_SERVICE_TYPES.has(req.type)) services.add(req.type);
		}
	}

	return {
		slug,
		dir,
		category: stringField(meta.category),
		description: stringField(meta.tagline) ?? stringField(launch.description),
		services: [...services].sort(),
		componentCount: components.length,
	};
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Every `<catalogRoot>/{apps,drafts}/<slug>/Launchfile`, apps first, each sorted by slug. */
export function loadEntries(catalogRoot: string): CatalogEntry[] {
	const out: CatalogEntry[] = [];
	for (const dir of ["apps", "drafts"] as const) {
		const base = join(catalogRoot, dir);
		if (!existsSync(base)) continue;
		const slugs = readdirSync(base)
			.filter((slug) => existsSync(join(base, slug, "Launchfile")))
			.sort();
		for (const slug of slugs) out.push(readEntry(catalogRoot, dir, slug));
	}
	return out;
}

// --- Tiers (test-all.ts) ---

export const TIER_NAMES: Record<number, string> = {
	0: "Zero dependencies (image only, no backing services)",
	1: "Postgres only",
	2: "Mixed backing services (Redis, MongoDB, MySQL, ...)",
	3: "Multi-component (2 components)",
	4: "Complex (3+ components)",
};

export function tierOf(entry: CatalogEntry): number {
	if (entry.componentCount >= 3) return 4;
	if (entry.componentCount === 2) return 3;
	if (entry.services.length === 0) return 0;
	if (entry.services.length === 1 && entry.services[0] === "postgres") return 1;
	return 2;
}

/**
 * Directories the batch run (test-all.ts) leaves out, with the reason: each
 * needs something the harness cannot supply (host access, a GPU, a claim token).
 */
export const SKIPPED: Record<string, string> = {
	"home-assistant": "multicast / device access",
	pihole: "host networking",
	plex: "claim token",
	diun: "docker socket",
	"calibre-web": "host bind mount",
	"ollama-openwebui": "GPU",
	jellyfin: "/dev/dri",
	duplicati: "host bind mount",
	syncthing: "host bind mount",
};

export interface TierList {
	name: string;
	apps: string[];
}

/** Every entry not in `SKIPPED`, grouped by `tierOf`. Throws on a `SKIPPED` slug with no directory. */
export function buildTiers(
	entries: CatalogEntry[],
	skipped: Record<string, string> = SKIPPED,
): Record<number, TierList> {
	const slugs = new Set(entries.map((e) => e.slug));
	const stale = Object.keys(skipped).filter((slug) => !slugs.has(slug));
	if (stale.length > 0) {
		throw new Error(`SKIPPED names no catalog directory: ${stale.join(", ")}`);
	}
	const tiers: Record<number, TierList> = {};
	for (const [num, name] of Object.entries(TIER_NAMES)) tiers[Number(num)] = { name, apps: [] };
	for (const entry of entries) {
		if (entry.slug in skipped) continue;
		tiers[tierOf(entry)]?.apps.push(entry.slug);
	}
	return tiers;
}

// --- Gaps (GAPS.md) ---

export interface GapIndex {
	/** Open gap IDs per slug, in GAPS.md order. */
	bySlug: Map<string, string[]>;
	/** `**Apps**:` names that matched no directory, as `G-N: name`. */
	unmatched: string[];
}

/** `**Apps**:` entries that describe a population, not a catalog app. */
function isGenericName(name: string): boolean {
	const n = name.replace(/\([^)]*\)/g, "").trim().toLowerCase();
	return n === "" || n === "many" || n === "various" || n.startsWith("any ") || n.startsWith("*");
}

/** Split on commas that sit outside parentheses. */
function splitNames(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of list) {
		if (ch === "(") depth++;
		if (ch === ")") depth = Math.max(0, depth - 1);
		if (ch === "," && depth === 0) {
			out.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	out.push(current);
	return out.map((s) => s.trim()).filter((s) => s !== "");
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Match a GAPS.md display name to a slug: the whole name first
 * ("Rocket.Chat" → `rocketchat`), then its first word against a slug's first
 * segment ("Nextcloud cron" → `nextcloud`, "Ollama" → `ollama-openwebui`).
 */
export function matchSlug(name: string, slugs: string[]): string | undefined {
	const bare = name.replace(/\([^)]*\)/g, "").trim();
	const whole = squash(bare);
	const exact = slugs.find((slug) => squash(slug) === whole);
	if (exact) return exact;
	const first = squash(bare.split(/\s+/)[0] ?? "");
	if (!first) return undefined;
	const byFirst = slugs.filter((slug) => squash(slug.split("-")[0] ?? "") === first);
	return byFirst.length === 1 ? byFirst[0] : undefined;
}

/** Gaps whose heading carries `CLOSED` are skipped. */
export function parseGaps(gapsMd: string, slugs: string[]): GapIndex {
	const bySlug = new Map<string, string[]>();
	const unmatched: string[] = [];
	let current: string | undefined;
	for (const line of gapsMd.split("\n")) {
		const heading = /^###\s+(G-\d+[a-z]?)\b(.*)$/.exec(line);
		if (heading) {
			current = /\bCLOSED\b/.test(heading[2] ?? "") ? undefined : heading[1];
			continue;
		}
		if (line.startsWith("#")) {
			current = undefined;
			continue;
		}
		const apps = /^\*\*Apps\*\*:\s*(.*)$/.exec(line);
		if (!apps || !current) continue;
		for (const name of splitNames(apps[1] ?? "")) {
			if (isGenericName(name)) continue;
			const slug = matchSlug(name, slugs);
			if (!slug) {
				unmatched.push(`${current}: ${name}`);
				continue;
			}
			const ids = bySlug.get(slug) ?? [];
			if (!ids.includes(current)) ids.push(current);
			bySlug.set(slug, ids);
		}
		current = undefined;
	}
	return { bySlug, unmatched };
}

// --- README tables ---

function cell(text: string | undefined): string {
	return text ? text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ") : "—";
}

export function renderTable(entries: CatalogEntry[], gaps: Map<string, string[]>): string {
	const rows = entries.map((e) => {
		const cells = [
			`[${e.slug}](${e.dir}/${e.slug}/)`,
			cell(e.category),
			cell(e.description),
			e.services.length ? e.services.join(", ") : "—",
			(gaps.get(e.slug) ?? []).join(", "),
		];
		return `|${cells.map((c) => (c ? ` ${c} ` : " ")).join("|")}|`;
	});
	return [
		"| App | Category | Description | Services | Gaps |",
		"|-----|----------|-------------|----------|------|",
		...rows,
	].join("\n");
}

const beginMarker = (section: CatalogDir): string =>
	`<!-- BEGIN GENERATED: ${section} — edit the directories, then run \`bun run build-index\` in catalog/test -->`;
const endMarker = (section: CatalogDir): string => `<!-- END GENERATED: ${section} -->`;

/** Replace the text between one section's markers. Throws if a marker is missing. */
export function replaceSection(readme: string, section: CatalogDir, body: string): string {
	const begin = readme.indexOf(`<!-- BEGIN GENERATED: ${section} `);
	const end = readme.indexOf(endMarker(section));
	if (begin === -1 || end === -1 || end < begin) {
		throw new Error(`catalog/README.md: missing or misordered GENERATED markers for "${section}"`);
	}
	return `${readme.slice(0, begin)}${beginMarker(section)}\n${body}\n${readme.slice(end)}`;
}

export function buildReadme(readme: string, entries: CatalogEntry[], gapsMd: string): {
	readme: string;
	unmatched: string[];
} {
	const { bySlug, unmatched } = parseGaps(
		gapsMd,
		entries.map((e) => e.slug),
	);
	let out = readme;
	for (const section of ["apps", "drafts"] as const) {
		out = replaceSection(
			out,
			section,
			renderTable(
				entries.filter((e) => e.dir === section),
				bySlug,
			),
		);
	}
	return { readme: out, unmatched };
}

// --- CLI ---

if (import.meta.main) {
	const catalogRoot = resolve(import.meta.dir, "..", "..");
	const readmePath = join(catalogRoot, "README.md");
	const check = process.argv.includes("--check");

	const entries = loadEntries(catalogRoot);
	const current = readFileSync(readmePath, "utf-8");
	const { readme, unmatched } = buildReadme(
		current,
		entries,
		readFileSync(join(catalogRoot, "GAPS.md"), "utf-8"),
	);

	for (const name of unmatched) {
		process.stderr.write(`warning: GAPS.md names no catalog directory — ${name}\n`);
	}

	const apps = entries.filter((e) => e.dir === "apps").length;
	const drafts = entries.length - apps;
	if (check) {
		if (readme !== current) {
			process.stderr.write(
				"catalog/README.md is out of date with catalog/{apps,drafts}/ — run `bun run build-index` in catalog/test and commit the result.\n",
			);
			process.exit(1);
		}
		process.stdout.write(`catalog/README.md is up to date (${apps} apps, ${drafts} drafts).\n`);
	} else if (readme === current) {
		process.stdout.write(`catalog/README.md unchanged (${apps} apps, ${drafts} drafts).\n`);
	} else {
		writeFileSync(readmePath, readme);
		process.stdout.write(`catalog/README.md rewritten (${apps} apps, ${drafts} drafts).\n`);
	}
}
