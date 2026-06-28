/**
 * Sätteri mdast plugin factory that rewrites relative markdown links to site
 * routes.
 *
 * Markdown files use relative links (DESIGN.md, ../spec/SPEC.md, ../AUTHORS)
 * that work on GitHub. This rewrites known links to their website equivalents
 * so they work in both contexts. The link map differs per site (launchfile.org
 * renders different docs than launchfile.dev), so the map is a parameter.
 *
 * Ported from the original remark plugin when the sites moved off the legacy
 * `@astrojs/markdown-remark` pipeline to Astro 7's native Sätteri engine. The
 * logic is identical — a visit over `link` nodes — but Sätteri's visitor API
 * replaces a node by returning the new node rather than mutating it in place.
 */

import { defineMdastPlugin } from "satteri";
import type { Link } from "mdast";

/**
 * Build a rewrite-links plugin for a given map of `relative path → href`.
 * Unmapped links are left untouched.
 */
export function createRewriteLinksPlugin(linkMap: Record<string, string>) {
	return defineMdastPlugin({
		name: "rewrite-links",
		link(node: Readonly<Link>) {
			const mapped = linkMap[node.url];
			if (mapped) {
				return { ...node, url: mapped };
			}
			return undefined;
		},
	});
}
