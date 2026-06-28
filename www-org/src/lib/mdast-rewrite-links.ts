/**
 * Sätteri mdast plugin that rewrites relative markdown links to site routes.
 *
 * Markdown files use relative links (DESIGN.md, GOVERNANCE.md, ../AUTHORS)
 * that work on GitHub. This plugin rewrites known links to their website
 * equivalents so they work in both contexts.
 *
 * Ported from the remark version (`remark-rewrite-links.ts`) when www-org moved
 * off the legacy `@astrojs/markdown-remark` pipeline to Astro 7's native Sätteri
 * engine. The logic is identical — a visit over `link` nodes — but Sätteri's
 * visitor API replaces a node by returning the new node rather than mutating it
 * in place.
 */

import { defineMdastPlugin } from "satteri";
import type { Link } from "mdast";

const GITHUB_REPO = "https://github.com/launchfile/launchfile";

/** Map of relative paths → site routes or GitHub URLs */
const linkMap: Record<string, string> = {
	// Files rendered as site pages
	"DESIGN.md": "/design/",
	"CONTRIBUTING.md": "/contributing/",
	"SPEC.md": "/spec/",

	// Files not rendered on site → GitHub blob
	"GOVERNANCE.md": `${GITHUB_REPO}/blob/main/spec/GOVERNANCE.md`,
	"../AUTHORS": `${GITHUB_REPO}/blob/main/AUTHORS`,
	"../catalog/": `${GITHUB_REPO}/tree/main/catalog`,
};

export const rewriteLinksPlugin = defineMdastPlugin({
	name: "rewrite-links",
	link(node: Readonly<Link>) {
		const mapped = linkMap[node.url];
		if (mapped) {
			return { ...node, url: mapped };
		}
		return undefined;
	},
});
