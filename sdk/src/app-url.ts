/**
 * The orchestrator-supplied publication context (D-58): validating and
 * normalizing the public URL a provider resolves `$app.*` from when routing
 * is owned upstream.
 *
 * D-58 rule 3's refusal posture and rule 2's `$app.url` normalization are
 * normative provider conduct (PROVIDERS.md §7), so they live here rather than
 * in any one provider: `@launchfile/docker` and `@launchfile/macos-dev` both
 * raise the same refusal with the same message, and a caller catching
 * {@link InvalidAppUrlError} catches it from either. The
 * `authority`/`scheme`/`tls` trio comes from `deriveAppUrlProperties` in the
 * resolver (D-35) — the same single-definition rule, one module over.
 */

import { deriveAppUrlProperties } from "./resolver.js";

/** URL delimiters that a userinfo run cannot cross. */
function isMaskDelimiter(c: string): boolean {
	return (
		c === "/" ||
		c === "?" ||
		c === "#" ||
		c === " " ||
		c === "\t" ||
		c === "\n" ||
		c === "\r"
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
 * A refused `appUrl` (D-58 rule 3). The provider cannot compute any correct
 * `$app.*` from a malformed publication URL, and every degraded alternative —
 * warning and proceeding, falling back to the provider's own routing answer,
 * or the `""` authority/scheme/tls half-resolution — hands the app a wrong
 * public address, which is D-52's fabrication in URL form. So it refuses,
 * naming the option.
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
 * Validate and normalize an orchestrator-supplied publication URL (D-58).
 *
 * Accepts only an absolute WHATWG-parseable URL with scheme `http` or `https`
 * and no userinfo, query, or fragment; anything else throws
 * `InvalidAppUrlError` — refuse, never degrade. The result is the WHATWG
 * serialization with a lone root path dropped (`https://x.example.com/` →
 * `https://x.example.com`), matching the no-trailing-slash shape of the
 * providers' own localhost URLs (ghost/gitea URL configs are slash-sensitive).
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
 * The address a supplied publication URL determines (D-58 rule 2): the
 * `$app.*` set minus `name`, in the parts D-35 names. `scheme`, `authority`
 * and `tls` are derived from `url`, so the six fields can never describe two
 * different addresses.
 */
export interface SuppliedAppAddress {
	/** The URL's hostname. */
	host: string;
	/** The URL's explicit port, else the scheme default (443/80). */
	port: number;
	/** The normalized URL, per {@link normalizeAppUrl}. */
	url: string;
	/** Hostname plus port, port omitted when it is the scheme default. */
	authority: string;
	/** `http` or `https`. */
	scheme: string;
	/** `"true"` when the scheme is https, else `"false"`. */
	tls: string;
}

/**
 * Derive the address a supplied publication URL determines — D-58 rule 2's
 * derivation itself, for every provider that documents an orchestrator-facing
 * channel.
 *
 * `url` is the normalized value, `host` its hostname, `port` its explicit port
 * or the scheme default (443/80), and the `authority`/`scheme`/`tls` trio comes
 * from `deriveAppUrlProperties` (D-35). The provider's own published host
 * ports are orthogonal — still allocated, just not the address anyone reaches
 * the app at under upstream routing — so this takes no port map. A provider
 * whose own address type carries the same six fields (`@launchfile/docker`'s
 * `publishedAddress`) returns this directly rather than keeping a copy.
 *
 * A malformed value throws {@link InvalidAppUrlError}; the caller gets no
 * degraded address to accidentally use.
 */
export function suppliedAppAddress(appUrl: string): SuppliedAppAddress {
	const url = normalizeAppUrl(appUrl);
	const u = new URL(url);
	return {
		host: u.hostname,
		// $app.port is the port of the public address (SPEC.md: the external
		// port the platform exposes) — explicit, else the scheme default.
		port: u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
		url,
		...deriveAppUrlProperties(url),
	};
}

/**
 * The full `$app.*` set a supplied publication URL determines (D-58 rule 2):
 * `name` plus {@link suppliedAppAddress}. For a provider that resolves the
 * whole set in one step (`@launchfile/macos-dev`).
 */
export function suppliedAppProperties(
	name: string,
	appUrl: string,
): Record<string, string | number> {
	return { name, ...suppliedAppAddress(appUrl) };
}
