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
	type AppEndpointProperties,
	type NormalizedLaunch,
	type NormalizedRequirement,
	suppliedAppAddress,
	UNPUBLISHED_APP_ENDPOINT,
} from "@launchfile/sdk";
import type { ResourceProperties } from "./resources/types.js";

/** The backing-service type that declares the app's public HTTPS origin (D-60). */
export const HTTPS_ORIGIN = "https-origin";

/**
 * Whether a supplied publication URL satisfies an `https-origin` entry: its
 * scheme is `https`. Syntactic only — `undefined` (nothing supplied and nothing
 * recorded) and an `http` URL both fail. Expects a normalized value, as
 * `launchUp` records it.
 */
export function httpsOriginSatisfied(appUrl: string | undefined): boolean {
	return appUrl !== undefined && suppliedAppAddress(appUrl).scheme === "https";
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

/**
 * The `$app.*` address of a primary whose component is refused (D-next):
 * every field `""` — the answer D-63 rule 4 gives an endpoint the provider
 * publishes no address for — with `tls` reading `false`, as D-63 rule 3 has
 * a listener with no origin read it, so a literal on/off flag
 * (`USE_SSL: $app.tls`) still receives a boolean. The same object
 * `@launchfile/docker` resolves (P-5).
 */
export const REFUSED_PRIMARY_ADDRESS: Readonly<AppEndpointProperties> =
	Object.freeze({ ...UNPUBLISHED_APP_ENDPOINT, tls: "false" });

/** The primary an `https-origin` entry declares (D-60 rule 3). */
export interface DeclaredPrimary {
	/** The component the entry sits on — the one that owns the named endpoint. */
	component: string;
	/**
	 * The entry is `requires:` and the publication context does not satisfy
	 * it, so `up` refuses the component (D-60 rule 5). It stays the primary; it
	 * has no address (D-next).
	 */
	refused: boolean;
}

/**
 * The primary an `https-origin` entry declares, when the file declares one
 * (D-60 rule 3), else `undefined`. **Declaration** fixes the primary, not
 * fulfillment: a `supports:` entry this provider leaves unsatisfied still
 * names it, and so does a `requires:` entry whose component this provider
 * refuses — `refused` says which, and `computeAppProperties` then resolves
 * the empty address rather than a surviving sibling's (D-next). Either way
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
 * string as `$app.url`. Mutates `resourceMap`; a no-op when the recorded
 * publication URL does not satisfy the type, so an unsatisfied entry's
 * `set_env` stays absent (never `""`) exactly as for any other resource this
 * provider did not provision.
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
			resourceMap[entry.name ?? entry.type] = { url };
		}
	}
}
