/**
 * Sätteri hast plugin: render a soft line break (a single newline within a
 * paragraph) as a hard `<br>`, matching how GitHub renders these repo `.md`
 * files. This is the Sätteri port of `remark-breaks` (the legacy
 * `@astrojs/markdown-remark` pipeline used that plugin; Sätteri has no native
 * hard-break feature).
 *
 * Shared by the launchfile.org and launchfile.dev sites — any page that renders
 * repo markdown (the spec docs on .org, the SDK README on .dev) wants the same
 * GitHub-faithful line breaks.
 *
 * CommonMark — and Sätteri by default — keeps a soft break as a `\n` inside a
 * text node's value, which collapses to a space in HTML. GitHub instead renders
 * it as a line break, and several of these docs are authored to rely on that.
 *
 * We run at the hast (HTML AST) level rather than mdast, for two reasons:
 *   1. Inserting `<br>` elements among inline siblings is natural here, whereas
 *      a mdast `rawHtml` replacement is treated as block content and wraps the
 *      fragment in a stray `<p>`, corrupting inline flow.
 *   2. `remark-breaks` only ever sees real text (never the contents of a `code`
 *      block, which is a distinct mdast node). At the hast level code text *is*
 *      a text node, so we explicitly skip any text under a `<pre>`/`<code>`
 *      ancestor to keep code blocks byte-for-byte literal.
 */

import { defineHastPlugin } from "satteri";
import type { Element, ElementContent, Parents, RootContent, Text } from "hast";

const CODE_ANCESTOR_TAGS = new Set(["pre", "code"]);
const NEWLINE = /\r?\n|\r/;

// Inline/phrasing tags. A whitespace-only newline that sits next to one of these
// (or to text) is a genuine soft break between inline content; one whose only
// neighbours are block elements is hast's inter-block formatting whitespace.
const INLINE_TAGS = new Set([
	"a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn",
	"em", "i", "img", "ins", "kbd", "mark", "q", "s", "samp", "small", "span",
	"strong", "sub", "sup", "time", "u", "var", "wbr",
]);

const br: Element = {
	type: "element",
	tagName: "br",
	properties: {},
	children: [],
};

function isInline(node: RootContent | undefined): boolean {
	if (!node) return false;
	if (node.type === "text") return true;
	return node.type === "element" && INLINE_TAGS.has(node.tagName);
}

export const githubBreaksPlugin = defineHastPlugin({
	name: "github-breaks",
	text(node: Readonly<Text>, ctx) {
		if (!NEWLINE.test(node.value)) return;

		// Leave newlines inside code (<pre>/<code>) literal.
		let ancestor: Readonly<Parents> | undefined = ctx.parent(node);
		while (ancestor) {
			if (
				ancestor.type === "element" &&
				CODE_ANCESTOR_TAGS.has(ancestor.tagName)
			) {
				return;
			}
			ancestor = ctx.parent(ancestor);
		}

		// A whitespace-only newline is hast inter-block formatting whitespace
		// (no mdast equivalent) UNLESS it sits between inline content — e.g. a
		// soft break right after inline `code` (`**Apps**: …`set_env`\n**Issue**…`).
		// Converting the former would spray stray <br>s between blocks; converting
		// the latter is the real soft break we must keep. A newline carrying
		// visible text is always a real break.
		if (node.value.trim() === "") {
			const parent = ctx.parent(node);
			const index = ctx.indexOf(node);
			if (!parent || index === undefined) return;
			const prev = parent.children[index - 1];
			const next = parent.children[index + 1];
			if (!isInline(prev) && !isInline(next)) return;
		}

		// Split on newlines and interleave <br> elements. Text values are escaped
		// by hast serialization, so no manual escaping is needed.
		const parts = node.value.split(/\r?\n|\r/);
		const replacement: ElementContent[] = [];
		parts.forEach((part, index) => {
			if (index > 0) replacement.push({ ...br });
			replacement.push({ type: "text", value: part });
		});

		ctx.insertBefore(node, replacement);
		ctx.removeNode(node);
	},
});
