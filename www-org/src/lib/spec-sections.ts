import { marked, type Tokens } from "marked";
import { createHighlighter, type Highlighter } from "shiki";

export interface SpecSection {
  slug: string;
  title: string;
  markdown: string;
  html: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .trim();
}

/**
 * Override the auto-generated slug (from the H2 heading) for selected sections.
 * Key = default slug produced by `slugify(heading)`. Value = final URL slug.
 *
 * Use this when the H2 heading reads better in prose than as a URL path — e.g.
 * "## Environment Variables" stays as a heading but routes to `/spec/env/` so
 * the URL matches the YAML key (`env`). The completeness checker reads this
 * same map so schema field → page matching stays consistent.
 */
export const SLUG_OVERRIDES: Record<string, string> = {
  "environment-variables": "env",
};

/**
 * Resolve the final URL slug for a section title, applying SLUG_OVERRIDES.
 */
export function resolveSlug(title: string): string {
  const defaultSlug = slugify(title);
  return SLUG_OVERRIDES[defaultSlug] ?? defaultSlug;
}

/** Map of anchor → href for cross-reference rewriting. Keys are the plain
 * slug of an `##` section title or of an `###`+ heading anywhere in the
 * document; values are `/spec/<slug>/` for a section, or
 * `/spec/<enclosing-section-slug>/#<heading-slug>` for a sub-heading. */
const sectionSlugs = new Map<string, string>();

/** `###`+ heading slugs that collided with an earlier heading's slug — the
 * earlier one (first in document order) kept the map entry; these lost the
 * anchor and are unreachable by link until one heading is renamed. Surfaced
 * by `check-spec-coverage.ts`. */
const anchorCollisions: string[] = [];

function rewriteInternalLinks(markdown: string): string {
  return markdown.replace(
    /\[([^\]]+)\]\(#([^)]+)\)/g,
    (match, text: string, anchor: string) => {
      const href = sectionSlugs.get(anchor);
      if (href) {
        return `[${text}](${href})`;
      }
      return match;
    }
  );
}

let cachedSections: SpecSection[] | null = null;
let highlighter: Highlighter | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ["github-dark"],
      langs: ["yaml", "bash", "json", "typescript", "javascript"],
    });
  }
  return highlighter;
}

export async function getSpecSections(): Promise<SpecSection[]> {
  if (cachedSections) return cachedSections;

  const { readFileSync } = await import("fs");
  const { resolve } = await import("path");

  // In Vite, process.cwd() is the www-org directory
  const specPath = resolve(process.cwd(), "../spec/SPEC.md");
  const raw = readFileSync(specPath, "utf-8");

  // Initialize Shiki highlighter
  const hl = await getHighlighter();

  // Configure marked with Shiki for code block highlighting
  const renderer = new marked.Renderer();
  renderer.code = function ({ text, lang }: Tokens.Code): string {
    if (lang === "mermaid") {
      return `<pre class="mermaid">${text}</pre>`;
    }
    const language = lang || "yaml"; // Default to YAML since this is a YAML spec
    try {
      return hl.codeToHtml(text, {
        lang: language,
        theme: "github-dark",
      });
    } catch {
      // Fallback for unsupported languages
      const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<pre class="shiki github-dark"><code>${escaped}</code></pre>`;
    }
  };
  renderer.heading = function ({ tokens, depth, text }: Tokens.Heading): string {
    const html = this.parser.parseInline(tokens);
    // The `##` line is stripped from each section's body before it reaches
    // marked (see below), so this only ever renders `###`+ headings — which
    // are exactly the ones that need an id for a same-page or cross-page
    // `#anchor` link to have something to scroll to.
    if (depth < 3) {
      return `<h${depth}>${html}</h${depth}>\n`;
    }
    return `<h${depth} id="${slugify(text)}">${html}</h${depth}>\n`;
  };

  // Remove the h1 title line
  const withoutH1 = raw.replace(/^# .+\n/, "");

  // Split by ## headings
  const parts = withoutH1.split(/(?=^## )/m).filter((s: string) => s.trim());

  // First pass: build slug map. Register both the default (heading-derived)
  // anchor and the final URL slug so `[text](#environment-variables)` and
  // `[text](#env)` both resolve to the same page.
  for (const part of parts) {
    const titleMatch = part.match(/^## (.+)$/m);
    if (titleMatch) {
      const title = titleMatch[1];
      const defaultSlug = slugify(title);
      const finalSlug = SLUG_OVERRIDES[defaultSlug] ?? defaultSlug;
      const href = `/spec/${finalSlug}/`;
      sectionSlugs.set(defaultSlug, href);
      if (finalSlug !== defaultSlug) {
        sectionSlugs.set(finalSlug, href);
      }
    }
  }

  // Second pass: register `###`+ heading anchors, keyed to their enclosing
  // `##` section. The fragment is the plain heading slug — what an author
  // writes and what GitHub already resolves — never a second override
  // table. First occurrence in document order wins a slug; a later heading
  // that produces the same slug is recorded as a collision rather than
  // silently overwriting the winner's href (reported by
  // check-spec-coverage.ts).
  for (const part of parts) {
    const titleMatch = part.match(/^## (.+)$/m);
    if (!titleMatch) continue;
    const defaultSlug = slugify(titleMatch[1]);
    const enclosingSlug = SLUG_OVERRIDES[defaultSlug] ?? defaultSlug;

    for (const [, headingText] of part.matchAll(/^#{3,6} (.+)$/gm)) {
      const headingSlug = slugify(headingText);
      if (sectionSlugs.has(headingSlug)) {
        anchorCollisions.push(headingSlug);
        continue;
      }
      sectionSlugs.set(headingSlug, `/spec/${enclosingSlug}/#${headingSlug}`);
    }
  }

  // Third pass: parse and render
  const sections: SpecSection[] = [];
  for (const part of parts) {
    const titleMatch = part.match(/^## (.+)$/m);
    const title = titleMatch?.[1] ?? "Untitled";
    const slug = resolveSlug(title);

    // Remove the ## heading from body (we render it ourselves)
    const body = part.replace(/^## .+\n/, "").trim();

    // Rewrite internal links
    const rewritten = rewriteInternalLinks(body);

    const html = await marked.parse(rewritten, { renderer, breaks: true });

    sections.push({ slug, title, markdown: rewritten, html });
  }

  cachedSections = sections;
  return sections;
}

export async function getSpecSection(
  slug: string
): Promise<SpecSection | undefined> {
  const sections = await getSpecSections();
  return sections.find((s) => s.slug === slug);
}

/** The anchor → href map, keyed by every `##` section slug and every
 * `###`+ heading slug in `spec/SPEC.md`. Used by `check-spec-coverage.ts`
 * to verify every `](#anchor)` in the spec resolves to a real heading. */
export async function getAnchorMap(): Promise<Map<string, string>> {
  await getSpecSections();
  return sectionSlugs;
}

/** Heading slugs produced by more than one `###`+ heading — the first in
 * document order won the anchor in `getAnchorMap()`; the rest are
 * unreachable by link until one heading is renamed. */
export async function getAnchorCollisions(): Promise<string[]> {
  await getSpecSections();
  return anchorCollisions;
}
