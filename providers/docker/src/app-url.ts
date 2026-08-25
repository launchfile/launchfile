/**
 * The `$app.*` property set (D-33, D-35) and the orchestrator-supplied
 * publication context that can replace its localhost default (#290).
 *
 * One implementation, consumed by all three resolution sites — the compose
 * generator (env values), bootstrap, and release — so a single deployment
 * resolves identical `$app.*` everywhere. The `authority`/`scheme`/`tls`
 * trio always comes from the SDK's `deriveAppUrlProperties`; no second copy
 * of that derivation exists here.
 */

import { deriveAppUrlProperties, type NormalizedLaunch } from "@launchfile/sdk";

/**
 * A refused `appUrl` (#290). The provider cannot compute any correct `$app.*`
 * from a malformed publication URL, and every degraded alternative — warning
 * and proceeding, falling back to localhost, or the `""` authority/scheme/tls
 * half-resolution — hands the app a wrong public address, which is D-52's
 * fabrication in URL form. So it refuses, naming the option.
 */
export class InvalidAppUrlError extends Error {
	/** An operator-fixable precondition, not a crash — see `ExpectedRefusal`. */
	readonly expectedRefusal = true as const;

	constructor(display: string, reason: string) {
		super(
			`Invalid appUrl "${display}": ${reason}.\n` +
				"The publication URL must be an absolute http:// or https:// URL with no userinfo,\n" +
				"query, or fragment (e.g. https://notes.example.com). Refusing to derive $app.* from\n" +
				"it — a degraded or guessed value would configure the app with a wrong public\n" +
				"address (D-35).",
		);
		this.name = "InvalidAppUrlError";
	}
}

/**
 * Validate and normalize an orchestrator-supplied publication URL (#290).
 *
 * Accepts only an absolute WHATWG-parseable URL with scheme `http` or `https`
 * and no userinfo, query, or fragment; anything else throws
 * `InvalidAppUrlError` — refuse, never degrade. The result is the WHATWG
 * serialization with a lone root path dropped (`https://x.example.com/` →
 * `https://x.example.com`), matching the no-trailing-slash shape of the
 * provider's own localhost URLs (ghost/gitea URL configs are slash-sensitive).
 * A non-root path is preserved verbatim (subpath deployments are real).
 * Idempotent: normalizing an already-normalized value returns it unchanged.
 */
export function normalizeAppUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new InvalidAppUrlError(value, "not a parseable absolute URL");
	}
	const path = url.pathname === "/" ? "" : url.pathname;
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new InvalidAppUrlError(
			value,
			`scheme "${url.protocol.replace(/:$/, "")}" is not http or https`,
		);
	}
	if (url.username !== "" || url.password !== "") {
		// The userinfo can be a live credential — mask it, never echo it back
		// (D-18, CWE-532).
		throw new InvalidAppUrlError(
			`${url.protocol}//***@${url.host}${path}`,
			"userinfo is not allowed",
		);
	}
	if (url.search !== "") {
		throw new InvalidAppUrlError(value, "a query string is not allowed");
	}
	if (url.hash !== "") {
		throw new InvalidAppUrlError(value, "a fragment is not allowed");
	}
	// Serialize from the parsed components. Userinfo/query/fragment are refused
	// above when non-empty, so protocol + host + path IS the WHATWG serialization
	// (empty delimiters like a lone trailing "?" don't survive), with the lone
	// root "/" dropped.
	return `${url.protocol}//${url.host}${path}`;
}

/**
 * Compute the full `$app.*` set (D-33, D-35) for the Docker provider.
 *
 * With no `appUrl`, the provider's own routing strategy answers: the "primary"
 * component is the first one (in declaration order) with at least one
 * `exposed: true` provides entry; its host port becomes `$app.port` and
 * `http://localhost:<hostPort>` becomes `$app.url`. Apps with no exposed
 * component get `port: 0` and `url: ""` (and empty authority/scheme/tls).
 *
 * With an `appUrl` — the orchestrator-supplied publication context (#290) —
 * the routing strategy has moved upstream, and the supplied URL answers
 * instead: `$app.url` is the normalized value, `$app.host` its hostname,
 * `$app.port` its explicit port or the scheme default (443/80). Published
 * host ports are orthogonal and still allocated; they just aren't the address
 * anyone reaches the app at.
 *
 * Either way the `authority`/`scheme`/`tls` trio is derived from the URL via
 * the SDK's `deriveAppUrlProperties`, so the split-field tokens (e.g.
 * HedgeDoc's `CMD_DOMAIN: $app.authority`) resolve from one definition. For
 * multi-exposed-component apps that need a specific component's URL, use
 * `$components.<name>.url` instead — `$app.*` always points at the primary
 * endpoint to give a single, predictable answer.
 */
export function computeAppProperties(
	launch: NormalizedLaunch,
	hostPorts: Record<string, number> | undefined,
	appUrl?: string,
): Record<string, string | number> {
	if (appUrl !== undefined) {
		const url = normalizeAppUrl(appUrl);
		const u = new URL(url);
		return {
			name: launch.name,
			host: u.hostname,
			// $app.port is the port of the public address (SPEC.md: the external
			// port the platform exposes) — explicit, else the scheme default.
			port: u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
			url,
			...deriveAppUrlProperties(url),
		};
	}

	let primaryPort = 0;
	for (const [name, component] of Object.entries(launch.components)) {
		// Only endpoints explicitly marked `exposed: true` are reachable from the
		// host (D-27), so only they can be the app's public address.
		const published =
			component.provides?.filter((p) => p.exposed === true) ?? [];
		if (published.length === 0) continue;
		// Prefer caller-supplied host port, fall back to the declared container port.
		primaryPort = hostPorts?.[name] ?? published[0]!.port;
		break;
	}

	const url = primaryPort > 0 ? `http://localhost:${primaryPort}` : "";
	return {
		name: launch.name,
		host: "localhost",
		port: primaryPort,
		url,
		...deriveAppUrlProperties(url),
	};
}
