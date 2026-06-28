import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { satteri } from "@astrojs/markdown-satteri";
import { rewriteLinksPlugin } from "./src/lib/mdast-rewrite-links.ts";
import { mermaidPlugin } from "./src/lib/mdast-mermaid.ts";
import { githubBreaksPlugin } from "./src/lib/hast-github-breaks.ts";

export default defineConfig({
  site: "https://launchfile.org",
  output: "static",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    // Astro 7's native Sätteri pipeline (replaces the legacy @astrojs/markdown-remark
    // remark/rehype path). Three plugins carry over the behaviors the legacy pipeline
    // provided:
    //   - rewriteLinks (mdast): relative .md links → site routes
    //   - mermaid (mdast): ```mermaid fences → <pre class="mermaid"> so DocsLayout
    //     renders them as diagrams (the content-collection path never did this)
    //   - githubBreaks (hast): soft line breaks → <br>, matching GitHub (remark-breaks)
    // shikiConfig still flows through the top-level markdown option.
    processor: satteri({
      mdastPlugins: [rewriteLinksPlugin, mermaidPlugin],
      hastPlugins: [githubBreaksPlugin],
    }),
    shikiConfig: {
      theme: "github-dark",
    },
  },
});
