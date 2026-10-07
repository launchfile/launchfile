/**
 * `https-origin` (D-60) under this provider — the one backing service that
 * sits in FRONT of the app.
 *
 * This provider runs no edge of its own, so it cannot provision an origin. It
 * can accept one the orchestrator already owns, through the publication-context
 * channel (`LaunchUpOpts.appUrl`, D-58), which for this type IS the D-56
 * supplied-resource channel (D-60 rule 5, PROVIDERS.md §7) — not a second one.
 * Satisfaction is decided on the supplied scheme alone: no request is made, and
 * D-56 rule 3 stands — the provider does not verify the origin exists or is
 * ready.
 */

import {
	httpsOriginSatisfied,
	type NormalizedLaunch,
	type NormalizedRequirement,
	REFUSED_PRIMARY_ADDRESS,
	suppliedAppAddress,
	useKeys,
} from "@launchfile/sdk";
import { uncoveredUses, withCoveredUses } from "./resources/index.js";
import type { ResourceProperties } from "./resources/types.js";

// Re-exported so callers of this provider keep testing `https-origin`
// satisfaction and reading the refused primary's address through
// `@launchfile/macos-dev` (the SDK owns both, so this provider and
// `@launchfile/docker` answer alike — P-5).
export { httpsOriginSatisfied, REFUSED_PRIMARY_ADDRESS };

/** The backing-service type that declares the app's public HTTPS origin (D-60). */
export const HTTPS_ORIGIN = "https-origin";

/**
 * The uses an `https-origin` entry declares that this provider cannot cover,
 * spelled as the file spells them. Asked of the use registry, never assumed:
 * a use registered for the type later is covered with no change here.
 */
export function uncoveredOriginUses(entry: NormalizedRequirement): string[] {
	return entry.uses ? uncoveredUses(entry.type, useKeys(entry.uses)) : [];
}

/**
 * Why one `https-origin` entry is not satisfied, for a refusal or a degraded
 * note — the same two reasons `@launchfile/docker` gives, so one Launchfile
 * behind one proxy reads the same message under either provider (P-5).
 */
export function httpsOriginShortfall(
	entry: NormalizedRequirement,
	appUrl: string | undefined,
): string {
	const label = `${entry.name ?? entry.type} (endpoint "${entry.endpoint ?? "?"}")`;
	return appUrl === undefined
		? `${label}: no publication URL was supplied, and this provider has no edge of its own`
		: `${label}: the supplied publication URL's scheme is "${suppliedAppAddress(appUrl).scheme}", not https`;
}

/** The primary an `https-origin` entry declares (D-60 rule 3). */
export interface DeclaredPrimary {
	/** The component the entry sits on — the one that owns the named endpoint. */
	component: string;
	/**
	 * The entry is `requires:` and the publication context does not satisfy
	 * it, so `up` refuses the component (D-60 rule 5). It stays the primary; it
	 * has no address (D-72).
	 */
	refused: boolean;
}

/**
 * The primary an `https-origin` entry declares, when the file declares one
 * (D-60 rule 3), else `undefined`. **Declaration** fixes the primary, not
 * fulfillment: a `supports:` entry this provider leaves unsatisfied still
 * names it, and so does a `requires:` entry whose component this provider
 * refuses — `refused` says which, and `computeAppProperties` then resolves
 * the empty address rather than a surviving sibling's (D-72). Either way
 * `$app.*` does not move with the provider's capability. The SDK caps the app
 * at one such entry and requires it to sit on the component that owns the
 * named endpoint, so the first match is the only one.
 *
 * `up` reads this before its refusals remove anything from
 * `launch.components`; `env` and `bootstrap` read the file whole. `appUrl` is
 * the effective publication context — supplied or recorded — normalized.
 */
export function declaredPrimary(
	launch: NormalizedLaunch,
	appUrl?: string,
): DeclaredPrimary | undefined {
	for (const [name, component] of Object.entries(launch.components)) {
		for (const entry of component.requires ?? []) {
			if (entry.type === HTTPS_ORIGIN && entry.endpoint !== undefined)
				return { component: name, refused: !httpsOriginSatisfied(appUrl) };
		}
		for (const entry of component.supports ?? []) {
			if (entry.type === HTTPS_ORIGIN && entry.endpoint !== undefined)
				return { component: name, refused: false };
		}
	}
	return undefined;
}

/**
 * Register every satisfied `https-origin` entry as a resource so its `set_env`
 * resolves. One registered property, `url` (D-60 rule 4), holding the same
 * string as `$app.url`, plus the properties of each declared use. Mutates
 * `resourceMap`; a no-op when the recorded publication URL does not satisfy
 * the type, so an unsatisfied entry's `set_env` stays absent (never `""`)
 * exactly as for any other resource this provider did not provision. An entry
 * declaring a use this provider cannot cover is unsatisfied the same way
 * (D-65): a `supports:` entry runs degraded, and a `requires:` one refused its
 * component before launch.
 */
export function wireHttpsOrigins(
	launch: NormalizedLaunch,
	resourceMap: Record<string, ResourceProperties>,
	appUrl: string | undefined,
): void {
	if (appUrl === undefined) return;
	const { scheme, url } = suppliedAppAddress(appUrl);
	if (scheme !== "https") return;
	for (const component of Object.values(launch.components)) {
		for (const entry of [
			...(component.requires ?? []),
			...(component.supports ?? []),
		]) {
			if (entry.type !== HTTPS_ORIGIN) continue;
			if (uncoveredOriginUses(entry).length > 0) continue;
			resourceMap[entry.name ?? entry.type] = withCoveredUses(
				entry.type,
				entry.uses ? useKeys(entry.uses) : undefined,
				{ url },
				{},
			);
		}
	}
}
