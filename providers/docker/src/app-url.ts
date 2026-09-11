/**
 * The `$app.*` property set (D-33, D-35) and the orchestrator-supplied
 * publication context that can replace its localhost default (D-58).
 *
 * One implementation, consumed by all three resolution sites — the compose
 * generator (env values), bootstrap, and release — so a single deployment
 * resolves identical `$app.*` everywhere. What a *supplied* URL determines
 * is D-58 rule 2's derivation and belongs to every provider with the channel,
 * so it comes from the SDK (`suppliedAppAddress`, `normalizeAppUrl`); only
 * this provider's own routing answer is computed here. The
 * `authority`/`scheme`/`tls` trio always comes from the SDK's
 * `deriveAppUrlProperties`; no second copy of that derivation exists here.
 *
 * {@link publishedAddress} is the provider's ONE derivation of a published
 * endpoint's host-side address. `$app.*` (here), the `status`/`up` printout
 * (`endpointAddress` in `provider.ts`) and the endpoint metadata the compose
 * generator persists all read it, so the address a deployment writes into an
 * app's config and the address it prints to the operator cannot disagree
 * (#473).
 */

import {
	deriveAppUrlProperties,
	effectiveListener,
	InvalidAppUrlError,
	type NormalizedLaunch,
	normalizeAppUrl,
	type Provides,
	suppliedAppAddress,
} from "@launchfile/sdk";
import { type PublishedEndpoint, publishedEndpoints } from "./port-allocator.js";

// Re-exported so callers of this provider keep catching the refusal and
// normalizing values through `@launchfile/docker` (the SDK owns both).
export { InvalidAppUrlError, normalizeAppUrl };

/** The backing-service type that declares the app's public HTTPS origin (D-60). */
export const HTTPS_ORIGIN = "https-origin";

/** The published endpoint an `https-origin` entry names as the app's primary. */
export interface DeclaredPrimaryEndpoint {
	/** Component that owns the endpoint. */
	component: string;
	/** The `provides` entry's `name` (D-6). */
	name: string;
	/** State/allocation key, per {@link publishedEndpoints}. */
	key: string;
	/** Container port the endpoint listens on. */
	port: number;
}

/**
 * The app's primary endpoint when an `https-origin` entry declares one
 * (D-60 rule 3), else `undefined`.
 *
 * **Declaration** fixes the primary, not fulfillment: a `supports:` entry this
 * provider cannot satisfy still names the primary, so `$app.*` does not change
 * value with the provider's capability. `requires` and `supports` are read
 * alike for that reason. The SDK caps the app at one such entry and validates
 * that the name resolves on the owning component, so the first match found is
 * the only one; a file that somehow carries more is read in declaration order
 * rather than refused here.
 */
export function declaredPrimaryEndpoint(
	launch: NormalizedLaunch,
): DeclaredPrimaryEndpoint | undefined {
	for (const [componentName, component] of Object.entries(launch.components)) {
		const entries = [
			...(component.requires ?? []),
			...(component.supports ?? []),
		];
		for (const entry of entries) {
			if (entry.type !== HTTPS_ORIGIN || entry.endpoint === undefined) continue;
			const match = publishedEndpoints(componentName, component.provides).find(
				(e) => e.name === entry.endpoint,
			);
			if (!match) continue;
			return {
				component: componentName,
				name: match.name ?? entry.endpoint,
				key: match.key,
				port: match.port,
			};
		}
	}
	return undefined;
}

/**
 * The host-side address of one published endpoint, in the parts D-35 names.
 * `scheme`, `authority` and `tls` are derived from `url`, so the six fields
 * can never describe two different addresses.
 */
export interface PublishedAddress {
	/** Hostname the endpoint is reached at. */
	host: string;
	/** Port of the public address — the published host port, or the supplied URL's. */
	port: number;
	/** The full address, or `""` when there is none to give. */
	url: string;
	/** Hostname plus port, port omitted when it is the scheme default. */
	authority: string;
	/** `http` or `https`, `""` when there is no address. */
	scheme: string;
	/** `"true"` when the scheme is https, else `"false"` (`""` with no address). */
	tls: string;
}

/**
 * Derive a published endpoint's address — the provider's single definition.
 *
 * Two inputs, in priority order:
 *
 * 1. `appUrl`, the orchestrator-supplied publication context (D-58). The
 *    routing strategy has moved upstream, so the supplied URL answers — via
 *    the SDK's `suppliedAppAddress`, the same derivation every provider with
 *    the channel uses — and the listener is not consulted at all (D-58 rules
 *    2 and 5).
 * 2. Otherwise the provider publishes the listener itself on `hostPort`, and
 *    the scheme is `https` exactly when the listener's **effective** protocol
 *    is `https` (D-61 rule 2) — either because the entry declares it or
 *    because a certificate bound to it is active. `ws` and `grpc` keep `http`:
 *    D-60 rule 4 fixes the HTTP-family origin as an http/https URL.
 *
 * `hostPort` of 0 means the app publishes nothing, which yields the empty URL
 * (and empty authority/scheme/tls) every unresolved `$app.*` property degrades
 * to.
 *
 * @param effectiveProtocol the listener's effective protocol, never the declared one
 * @throws InvalidAppUrlError when `appUrl` is supplied and malformed
 */
export function publishedAddress(
	effectiveProtocol: string | undefined,
	hostPort: number,
	appUrl?: string,
): PublishedAddress {
	if (appUrl !== undefined) return suppliedAppAddress(appUrl);
	const scheme = effectiveProtocol === "https" ? "https" : "http";
	const url = hostPort > 0 ? `${scheme}://localhost:${hostPort}` : "";
	return {
		host: "localhost",
		port: hostPort,
		url,
		...deriveAppUrlProperties(url),
	};
}

/** A published endpoint together with the address the host reaches it at. */
export interface PublishedEndpointAddress extends PublishedEndpoint {
	/** Host port this endpoint was published on. */
	hostPort: number;
	/** The listener's effective protocol (D-61 rule 2), not the declared one. */
	effectiveProtocol: string;
	/** This endpoint's address, from {@link publishedAddress}. */
	address: PublishedAddress;
}

/**
 * Every host-published endpoint of one component, each with its address.
 *
 * `publishedEndpoints` stays the single answer to *which* endpoints are
 * published and what key each is allocated under; this adds the single answer
 * to *what address* each one has. Index alignment holds because both read the
 * same `exposed: true` filter in declaration order.
 *
 * The host port is the caller's allocation for that key, falling back to the
 * declared container port when no allocator has run.
 */
export function publishedEndpointAddresses(
	componentName: string,
	provides: Provides[] | undefined,
	hostPorts?: Record<string, number>,
	activeCertificates?: ReadonlySet<string>,
): PublishedEndpointAddress[] {
	const entries = provides?.filter((p) => p.exposed === true) ?? [];
	return publishedEndpoints(componentName, provides).map((endpoint, index) => {
		const hostPort = hostPorts?.[endpoint.key] ?? endpoint.port;
		const { protocol } = effectiveListener(entries[index]!, activeCertificates);
		return {
			...endpoint,
			hostPort,
			effectiveProtocol: protocol,
			address: publishedAddress(protocol, hostPort),
		};
	});
}

/**
 * The app's primary published endpoint: the one an `https-origin` entry names
 * when the file declares one (D-60 rule 3), else — positionally, as before —
 * the first `exposed: true` entry of the first component that has one.
 * `undefined` when the app publishes nothing.
 */
export function primaryPublishedEndpoint(
	launch: NormalizedLaunch,
	hostPorts?: Record<string, number>,
	activeCertificates?: ReadonlySet<string>,
): PublishedEndpointAddress | undefined {
	const declared = declaredPrimaryEndpoint(launch);
	if (declared) {
		// A declared `https-origin` names the primary explicitly, so the
		// positional answer below does not run — that is the whole point of
		// D-60 rule 3. The named endpoint carries its own allocation key,
		// which is how a non-first endpoint (openclaw's `bridge`) gets the
		// host port that was actually allocated for it.
		return publishedEndpointAddresses(
			declared.component,
			launch.components[declared.component]?.provides,
			hostPorts,
			activeCertificates,
		).find((e) => e.key === declared.key);
	}
	for (const [name, component] of Object.entries(launch.components)) {
		// Only endpoints explicitly marked `exposed: true` are reachable from the
		// host (D-27), so only they can be the app's public address.
		const published = publishedEndpointAddresses(
			name,
			component.provides,
			hostPorts,
			activeCertificates,
		);
		if (published.length > 0) return published[0];
	}
	return undefined;
}

/**
 * Compute the full `$app.*` set (D-33, D-35) for the Docker provider.
 *
 * `$app.*` is the address of the app's **primary** endpoint (see
 * {@link primaryPublishedEndpoint}), derived by {@link publishedAddress} —
 * the same call the `status`/`up` printout makes for that endpoint, so the two
 * surfaces always agree (#473). Apps with no exposed component get `port: 0`
 * and `url: ""` (and empty authority/scheme/tls).
 *
 * With an `appUrl` — the orchestrator-supplied publication context (D-58) —
 * the routing strategy has moved upstream and the supplied URL answers
 * instead. Published host ports are orthogonal and still allocated; they just
 * aren't the address anyone reaches the app at.
 *
 * For multi-exposed-component apps that need a specific component's URL, use
 * `$components.<name>.url` instead — `$app.*` always points at the primary
 * endpoint to give a single, predictable answer.
 */
export function computeAppProperties(
	launch: NormalizedLaunch,
	hostPorts: Record<string, number> | undefined,
	appUrl?: string,
	activeCertificates?: ReadonlySet<string>,
): Record<string, string | number> {
	const primary = primaryPublishedEndpoint(launch, hostPorts, activeCertificates);
	return {
		name: launch.name,
		...publishedAddress(primary?.effectiveProtocol, primary?.hostPort ?? 0, appUrl),
	};
}
