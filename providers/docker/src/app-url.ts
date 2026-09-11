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

import {
	deriveAppUrlProperties,
	effectiveListener,
	type NormalizedLaunch,
	type Provides,
} from "@launchfile/sdk";
import { publishedEndpoints } from "./port-allocator.js";

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

/** URL delimiters that a userinfo run cannot cross. */
function isMaskDelimiter(c: string): boolean {
	return (
		c === "/" || c === "?" || c === "#" || c === " " || c === "\t" || c === "\n" || c === "\r"
	);
}

/**
 * Mask credential-bearing runs in URL-shaped text: any non-empty run of
 * non-delimiter characters ending in `@` collapses to `***@`. This catches
 * WHATWG userinfo (`https://user:pass@host`), the slash-less special-scheme
 * form the parser accepts (`http:user:pass@host`), and userinfo-shaped text
 * in strings that failed to parse at all. Over-masking a harmless `@`
 * elsewhere in the value is accepted — D-18's fail-closed posture: the
 * display exists so the operator recognizes their input, not to preserve it
 * byte-for-byte.
 *
 * Single pass, no regex — the value is untrusted input and an equivalent
 * `[^/?#\s]+@` replace is a polynomial-backtracking surface
 * (js/polynomial-redos).
 */
function maskUserinfo(text: string): string {
	let out = "";
	let run = ""; // current run of non-delimiter characters, not yet emitted
	for (const c of text) {
		if (isMaskDelimiter(c)) {
			out += run + c;
			run = "";
		} else if (c === "@" && run !== "") {
			out += "***@"; // drop the run — it is (or may contain) the credential
			run = "";
		} else if (c === "@") {
			out += "@";
		} else {
			run += c;
		}
	}
	return out + run;
}

/**
 * A refused `appUrl` (#290). The provider cannot compute any correct `$app.*`
 * from a malformed publication URL, and every degraded alternative — warning
 * and proceeding, falling back to localhost, or the `""` authority/scheme/tls
 * half-resolution — hands the app a wrong public address, which is D-52's
 * fabrication in URL form. So it refuses, naming the option.
 *
 * The constructor masks userinfo in the displayed value itself, so no refusal
 * path — including ones added later — can echo an embedded credential into
 * terminal output or diagnostics (D-18, CWE-532). Call sites pass the raw
 * value; masking is not their job.
 */
export class InvalidAppUrlError extends Error {
	/** An operator-fixable precondition, not a crash — see `ExpectedRefusal`. */
	readonly expectedRefusal = true as const;

	constructor(display: string, reason: string) {
		super(
			`Invalid appUrl "${maskUserinfo(display)}": ${reason}.\n` +
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
		throw new InvalidAppUrlError(value, "userinfo is not allowed");
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
 * With no `appUrl`, the provider's own routing strategy answers. Which endpoint
 * it answers for is the app's **primary**: the one an `https-origin` entry
 * names when the file declares one (D-60 rule 3), else — positionally, as
 * before — the first `exposed: true` entry of the first component that has
 * one. Its host port becomes `$app.port` and `http://localhost:<hostPort>`
 * becomes `$app.url`. Apps with no exposed component get `port: 0` and
 * `url: ""` (and empty authority/scheme/tls).
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
	activeCertificates?: ReadonlySet<string>,
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
	/**
	 * The primary endpoint's `provides` entry, when the positional or declared
	 * choice resolves to one — the listener `$app.url` is computed from. This
	 * branch IS the provider computing the public address from its own direct
	 * publication of that listener, which is the one place D-61 rule 2 has
	 * `$app.*` read the EFFECTIVE protocol. The supplied-URL branch above never
	 * does: a supplied publication context wins (D-58 rule 5).
	 */
	let primaryEntry: Provides | undefined;
	const declared = declaredPrimaryEndpoint(launch);
	if (declared) {
		// A declared `https-origin` names the primary explicitly, so the
		// positional answer below does not run — that is the whole point of
		// D-60 rule 3. The named endpoint carries its own allocation key,
		// which is how a non-first endpoint (openclaw's `bridge`) gets the
		// host port that was actually allocated for it.
		primaryPort = hostPorts?.[declared.key] ?? declared.port;
		primaryEntry = launch.components[declared.component]?.provides?.find(
			(p) => p.name === declared.name,
		);
	} else {
		for (const [name, component] of Object.entries(launch.components)) {
			// Only endpoints explicitly marked `exposed: true` are reachable from the
			// host (D-27), so only they can be the app's public address.
			const published =
				component.provides?.filter((p) => p.exposed === true) ?? [];
			if (published.length === 0) continue;
			// Prefer caller-supplied host port, fall back to the declared container port.
			primaryPort = hostPorts?.[name] ?? published[0]!.port;
			primaryEntry = published[0];
			break;
		}
	}

	// `https` only when a certificate bound to that very entry is active
	// (D-61 rule 2). Every other app keeps the localhost answer byte for byte.
	const scheme =
		primaryEntry !== undefined &&
		effectiveListener(primaryEntry, activeCertificates).active
			? "https"
			: "http";
	const url = primaryPort > 0 ? `${scheme}://localhost:${primaryPort}` : "";
	return {
		name: launch.name,
		host: "localhost",
		port: primaryPort,
		url,
		...deriveAppUrlProperties(url),
	};
}
