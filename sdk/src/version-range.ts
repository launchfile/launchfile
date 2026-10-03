/**
 * The one comparison every provider runs between a `requires[].version` range
 * and what it provisions (PROVIDERS.md §10 item 8, D-next). SPEC.md defines
 * `version` as node-semver range syntax, so the comparison is node-semver's.
 *
 * The comparison only classifies. Each provider phrases its own report,
 * because only it knows what it provisions and how.
 */

import { intersects, subset, validRange } from "semver";

/**
 * How a declared range relates to what a provider provisions.
 *
 * - `satisfied`   — every version the provider may run is inside the range.
 * - `unsatisfied` — no version the provider may run is inside the range.
 * - `undecidable` — some are and some are not: `16.x` against `^16.2`.
 * - `unknown`     — the provider does not know which version it runs.
 * - `invalid`     — the declared string is not a node-semver range.
 */
export type VersionRangeCheck =
	| "satisfied"
	| "unsatisfied"
	| "undecidable"
	| "unknown"
	| "invalid";

/**
 * Compare a declared `requires[].version` range with what a provider runs.
 *
 * `provided` is a node-semver version or range naming every version the
 * provider may run — an exact `16.4.0` when it asked the server, a family
 * `16.x` when it pins only an image tag or a parameter group. `undefined`, or a
 * string that is not a range, means the provider does not know.
 */
export function checkVersionRange(
	declared: string,
	provided: string | undefined,
): VersionRangeCheck {
	if (validRange(declared) === null) return "invalid";
	if (provided === undefined || validRange(provided) === null) return "unknown";
	if (subset(provided, declared)) return "satisfied";
	if (!intersects(provided, declared)) return "unsatisfied";
	return "undecidable";
}
