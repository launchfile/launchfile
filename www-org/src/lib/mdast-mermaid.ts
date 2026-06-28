/**
 * Sätteri mdast plugin: emit a ```mermaid fenced code block as
 * `<pre class="mermaid">…</pre>` so the client-side mermaid runner in
 * DocsLayout.astro turns it into a diagram, instead of a syntax-highlighted
 * code block.
 *
 * The standalone SPEC.md pipeline (`spec-sections.ts`, via `marked`) already
 * does this; the Astro markdown pipeline (content-collection docs like
 * DESIGN.md) never did, so its mermaid diagram rendered as text. This closes
 * that gap on the native Sätteri engine.
 */

import { defineMdastPlugin } from "satteri";
import type { Code } from "mdast";

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export const mermaidPlugin = defineMdastPlugin({
	name: "mermaid",
	code(node: Readonly<Code>) {
		if (node.lang === "mermaid") {
			return { rawHtml: `<pre class="mermaid">${escapeHtml(node.value)}</pre>` };
		}
		return undefined;
	},
});
