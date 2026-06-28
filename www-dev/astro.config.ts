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

// launchfile.dev renders the SDK README (sdk/README.md). Rewrite its relative
// links: the spec lives on launchfile.org; LICENSE isn't a site page → GitHub.
const rewriteLinksPlugin = createRewriteLinksPlugin({
  "../spec/SPEC.md": "https://launchfile.org/spec/",
  "../LICENSE": `${GITHUB_REPO}/blob/main/LICENSE`,
});

export default defineConfig({
  site: "https://launchfile.dev",
  output: "static",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    // Astro 7's native Sätteri pipeline with the markdown plugins shared with
    // launchfile.org via www-shared/lib/markdown. githubBreaks makes the SDK
    // README render its soft line breaks as <br>, matching GitHub.
    processor: satteri({
      mdastPlugins: [rewriteLinksPlugin, mermaidPlugin],
      hastPlugins: [githubBreaksPlugin],
    }),
    shikiConfig: {
      theme: "github-dark",
    },
  },
});
