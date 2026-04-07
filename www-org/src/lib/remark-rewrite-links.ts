/**
 * Remark plugin that rewrites relative markdown links to site routes.
 *
 * Markdown files use relative links (DESIGN.md, GOVERNANCE.md, ../AUTHORS)
 * that work on GitHub. This plugin rewrites known links to their website
 * equivalents so they work in both contexts.
 */

import { visit } from "unist-util-visit";
import type { Root, Link } from "mdast";

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

export function remarkRewriteLinks() {
	return (tree: Root) => {
		visit(tree, "link", (node: Link) => {
			const mapped = linkMap[node.url];
			if (mapped) {
				node.url = mapped;
			}
		});
	};
}
