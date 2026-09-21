/**
 * `at:` on a `provides` entry (D-68): the names a published listener
 * answers at, relative to the app host.
 */

import type { NormalizedLaunch } from "./types.js";

/** The `at:` value naming the app host itself. */
export const AT_APP_HOST = "@";

/** One `provides` entry that declares `at:`. */
export interface AtDeclaration {
	/** The component that owns the entry. */
	component: string;
	/** The entry's position in that component's `provides` list. */
	index: number;
	/** The entry's `name:`, when it has one. */
	name?: string;
	/** The declared values, in file order. */
	values: string[];
}

/**
 * Every `provides` entry that declares `at:`. A provider sets up each value or
 * reports it (D-68 rule 5), so this is the list it must answer for. Empty for
 * a Launchfile that declares no `at:`.
 */
export function atDeclarations(launch: NormalizedLaunch): AtDeclaration[] {
	const out: AtDeclaration[] = [];
	for (const [component, def] of Object.entries(launch.components)) {
		for (const [index, entry] of (def.provides ?? []).entries()) {
			if (entry.at === undefined) continue;
			out.push({
				component,
				index,
				...(entry.name !== undefined ? { name: entry.name } : {}),
				values: entry.at,
			});
		}
	}
	return out;
}

/** How an {@link AtDeclaration}'s entry is named in a message. */
export function atEntryLabel(declaration: AtDeclaration): string {
	const entry =
		declaration.name !== undefined
			? `"${declaration.name}"`
			: `#${declaration.index + 1} (unnamed)`;
	return `\`provides\` entry ${entry} on ${declaration.component}`;
}
