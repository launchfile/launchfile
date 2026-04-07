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

/** Map of slug → href for cross-reference rewriting */
const sectionSlugs = new Map<string, string>();

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

  // Remove the h1 title line
  const withoutH1 = raw.replace(/^# .+\n/, "");

  // Split by ## headings
  const parts = withoutH1.split(/(?=^## )/m).filter((s: string) => s.trim());

  // First pass: build slug map
  for (const part of parts) {
    const titleMatch = part.match(/^## (.+)$/m);
    if (titleMatch) {
      const title = titleMatch[1];
      const slug = slugify(title);
      sectionSlugs.set(slug, `/spec/${slug}/`);
    }
  }

  // Second pass: parse and render
  const sections: SpecSection[] = [];
  for (const part of parts) {
    const titleMatch = part.match(/^## (.+)$/m);
    const title = titleMatch?.[1] ?? "Untitled";
    const slug = slugify(title);

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
