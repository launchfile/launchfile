/**
 * Shared Sätteri markdown plugins for the Launchfile sites (launchfile.org,
 * launchfile.dev). Wire them into `astro.config`'s `markdown.processor`:
 *
 *   import { satteri } from "@astrojs/markdown-satteri";
 *   import {
 *     githubBreaksPlugin, mermaidPlugin, createRewriteLinksPlugin,
 *   } from "../www-shared/lib/markdown/index.ts";
 *
 *   markdown: {
 *     processor: satteri({
 *       mdastPlugins: [createRewriteLinksPlugin(MY_LINK_MAP), mermaidPlugin],
 *       hastPlugins: [githubBreaksPlugin],
 *     }),
 *     shikiConfig: { theme: "github-dark" },
 *   }
 */

export { githubBreaksPlugin } from "./hast-github-breaks.ts";
export { mermaidPlugin } from "./mdast-mermaid.ts";
export { createRewriteLinksPlugin } from "./mdast-rewrite-links.ts";
