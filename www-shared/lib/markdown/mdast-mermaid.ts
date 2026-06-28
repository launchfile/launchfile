/**
 * Sätteri mdast plugin: emit a ```mermaid fenced code block as
 * `<pre class="mermaid">…</pre>` so a client-side mermaid runner (e.g.
 * DocsLayout.astro on launchfile.org) turns it into a diagram, instead of a
 * syntax-highlighted code block.
 *
 * Shared across the sites that render repo markdown. Harmless no-op on pages
 * with no ```mermaid fences.
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
