import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import remarkBreaks from "remark-breaks";
import { remarkRewriteLinks } from "./src/lib/remark-rewrite-links.ts";

export default defineConfig({
  site: "https://launchfile.org",
  output: "static",
  adapter: cloudflare({ prerenderEnvironment: "node" }),
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    remarkPlugins: [remarkBreaks, remarkRewriteLinks],
    shikiConfig: {
      theme: "github-dark",
    },
  },
});
