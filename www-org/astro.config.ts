import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { satteri } from "@astrojs/markdown-satteri";
import {
  githubBreaksPlugin,
  mermaidPlugin,
  createRewriteLinksPlugin,
} from "../www-shared/lib/markdown/index.ts";

const GITHUB_REPO = "https://github.com/launchfile/launchfile";

// launchfile.org renders the spec docs; rewrite their relative links to site routes.
const rewriteLinksPlugin = createRewriteLinksPlugin({
  // Files rendered as site pages
  "DESIGN.md": "/design/",
  "CONTRIBUTING.md": "/contributing/",
  "SPEC.md": "/spec/",
  // Files not rendered on site → GitHub blob
  "GOVERNANCE.md": `${GITHUB_REPO}/blob/main/spec/GOVERNANCE.md`,
  "../AUTHORS": `${GITHUB_REPO}/blob/main/AUTHORS`,
  "../catalog/": `${GITHUB_REPO}/tree/main/catalog`,
});

export default defineConfig({
  site: "https://launchfile.org",
  output: "static",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    // Astro 7's native Sätteri pipeline. Markdown plugins are shared with
    // launchfile.dev via www-shared/lib/markdown:
    //   - rewriteLinks (mdast): relative .md links → site routes (per-site map)
    //   - mermaid (mdast): ```mermaid fences → <pre class="mermaid"> diagrams
    //   - githubBreaks (hast): soft line breaks → <br>, matching GitHub
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
