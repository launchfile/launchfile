import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildReadme,
	buildTiers,
	type CatalogEntry,
	loadEntries,
	matchSlug,
	parseGaps,
	replaceSection,
	SKIPPED,
	tierOf,
} from "./build-index.ts";

function entry(overrides: Partial<CatalogEntry>): CatalogEntry {
	return {
		slug: "example",
		dir: "apps",
		category: undefined,
		description: undefined,
		services: [],
		componentCount: 1,
		...overrides,
	};
}

function writeApp(root: string, dir: string, slug: string, launchfile: string, metadata?: string) {
	const base = join(root, dir, slug);
	mkdirSync(base, { recursive: true });
	writeFileSync(join(base, "Launchfile"), launchfile);
	if (metadata !== undefined) writeFileSync(join(base, "metadata.yaml"), metadata);
}

const README = `# Catalog

## Tested Apps

<!-- BEGIN GENERATED: apps -->
<!-- END GENERATED: apps -->

## Proposed Apps

<!-- BEGIN GENERATED: drafts -->
| hand-written | row |
<!-- END GENERATED: drafts -->

## Promoting a Draft
`;

describe("loadEntries", () => {
	it("reads category, tagline and services from each directory", () => {
		const root = mkdtempSync(join(tmpdir(), "build-index-"));
		writeApp(
			root,
			"apps",
			"blog",
			`name: blog
description: "From the Launchfile"
image: example/blog:1
requires:
  - type: postgres
  - type: https-origin
    endpoint: web
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
`,
			'category: CMS\ntagline: "From metadata"\n',
		);
		writeApp(root, "drafts", "notes", 'name: notes\ndescription: "Only a Launchfile"\nimage: example/notes:1\n');
		mkdirSync(join(root, "drafts", "empty-dir"), { recursive: true });

		expect(loadEntries(root)).toEqual([
			entry({ slug: "blog", category: "CMS", description: "From metadata", services: ["postgres"] }),
			entry({ slug: "notes", dir: "drafts", description: "Only a Launchfile" }),
		]);
	});

	it("collects requires across components", () => {
		const root = mkdtempSync(join(tmpdir(), "build-index-"));
		writeApp(
			root,
			"drafts",
			"multi",
			`name: multi
components:
  web:
    image: example/web:1
    requires:
      - type: redis
  worker:
    image: example/worker:1
    requires:
      - type: postgres
      - type: redis
`,
		);
		const [multi] = loadEntries(root);
		expect(multi?.services).toEqual(["postgres", "redis"]);
		expect(multi?.componentCount).toBe(2);
	});

	it("throws on a Launchfile that fails the schema", () => {
		const root = mkdtempSync(join(tmpdir(), "build-index-"));
		writeApp(root, "apps", "broken", "name: broken\nimage: [not, a, string]\n");
		expect(() => loadEntries(root)).toThrow();
	});
});

describe("tierOf", () => {
	it("assigns tiers by components, then by backing services", () => {
		expect(tierOf(entry({}))).toBe(0);
		expect(tierOf(entry({ services: ["postgres"] }))).toBe(1);
		expect(tierOf(entry({ services: ["mysql"] }))).toBe(2);
		expect(tierOf(entry({ services: ["postgres", "redis"] }))).toBe(2);
		expect(tierOf(entry({ componentCount: 2, services: ["postgres"] }))).toBe(3);
		expect(tierOf(entry({ componentCount: 3 }))).toBe(4);
	});
});

describe("buildTiers", () => {
	it("leaves skipped slugs out of every tier", () => {
		const tiers = buildTiers([entry({ slug: "keep" }), entry({ slug: "skip" })], { skip: "host networking" });
		expect(tiers[0]?.apps).toEqual(["keep"]);
	});

	it("throws when a skipped slug has no directory", () => {
		expect(() => buildTiers([entry({ slug: "keep" })], { gone: "renamed" })).toThrow(/gone/);
	});

	it("covers every catalog directory not in SKIPPED", () => {
		const entries = loadEntries(resolve(import.meta.dirname, "..", ".."));
		const tiered = Object.values(buildTiers(entries)).flatMap((t) => t.apps);
		expect(tiered.length + Object.keys(SKIPPED).length).toBe(entries.length);
	});
});

describe("matchSlug", () => {
	const slugs = ["rocketchat", "nextcloud", "ollama-openwebui", "home-assistant", "hedgedoc", "hedgedoc-v2"];

	it("matches a display name to its slug", () => {
		expect(matchSlug("Rocket.Chat", slugs)).toBe("rocketchat");
		expect(matchSlug("Home Assistant (USB dongles)", slugs)).toBe("home-assistant");
		expect(matchSlug("HedgeDoc", slugs)).toBe("hedgedoc");
	});

	it("falls back to a unique first word", () => {
		expect(matchSlug("Nextcloud cron", slugs)).toBe("nextcloud");
		expect(matchSlug("Ollama", slugs)).toBe("ollama-openwebui");
	});

	it("returns undefined when nothing or more than one slug matches", () => {
		expect(matchSlug("Plex", slugs)).toBeUndefined();
		expect(matchSlug("HedgeDoc 2", ["hedgedoc", "hedgedoc-v2"])).toBeUndefined();
	});
});

describe("parseGaps", () => {
	const gaps = `# Gaps

### G-1: Something 🟡
**Apps**: Plex (claim), Nextcloud cron, Mystery App

### G-4: Closed thing — CLOSED
**Apps**: Plex

### G-15: Env files 🟢
**Apps**: Many (esp. LinuxServer.io images)

### G-20: Localhost 🟡
**Apps**: *(no catalog apps currently affected)*

## Apps per Gap

| G-1 | Plex |
`;

	it("maps open gaps to slugs and skips closed ones", () => {
		const { bySlug } = parseGaps(gaps, ["plex", "nextcloud"]);
		expect(Object.fromEntries(bySlug)).toEqual({ plex: ["G-1"], nextcloud: ["G-1"] });
	});

	it("reports names that match no directory, but not generic ones", () => {
		expect(parseGaps(gaps, ["plex", "nextcloud"]).unmatched).toEqual(["G-1: Mystery App"]);
	});
});

describe("buildReadme", () => {
	it("fills both sections and is idempotent", () => {
		const entries = [
			entry({ slug: "blog", category: "CMS", description: "A | pipe", services: ["mysql"] }),
			entry({ slug: "notes", dir: "drafts" }),
		];
		const gaps = "### G-3: x\n**Apps**: Blog\n";
		const first = buildReadme(README, entries, gaps).readme;

		expect(first).toContain("| [blog](apps/blog/) | CMS | A \\| pipe | mysql | G-3 |");
		expect(first).toContain("| [notes](drafts/notes/) | — | — | — | |");
		expect(first).not.toContain("hand-written");
		expect(first).toContain("## Promoting a Draft");
		expect(buildReadme(first, entries, gaps).readme).toBe(first);
	});

	it("throws when a section's markers are missing", () => {
		expect(() => replaceSection("# no markers\n", "apps", "x")).toThrow(/apps/);
	});

	it("matches the committed catalog/README.md", () => {
		const catalogRoot = resolve(import.meta.dirname, "..", "..");
		const current = readFileSync(join(catalogRoot, "README.md"), "utf-8");
		const { readme } = buildReadme(
			current,
			loadEntries(catalogRoot),
			readFileSync(join(catalogRoot, "GAPS.md"), "utf-8"),
		);
		expect(readme, "catalog/README.md is stale — run `bun run build-index` in catalog/test").toBe(current);
	});
});
