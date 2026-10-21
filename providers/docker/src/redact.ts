/**
 * Secret redaction for anything this provider prints or embeds in an error.
 *
 * Mirrors `providers/macos-dev/src/redact.ts` — same API, same two layers, so
 * the two reference providers handle credentials the same way (P-5) and the
 * D-18 obligation ("mask it in logs and UI") is met on both:
 *
 * 1. A registry of exact secret values. Every generated password/secret
 *    registers itself at creation time, and `loadState` re-registers every
 *    persisted map it reads back — `state.secrets`, `state.resourcePasswords`,
 *    and `state.generatedEnv` — at load time. Every `secrets` and
 *    `resourcePasswords` map handed to the release planner registers its
 *    values too. `redactSecrets` then scrubs those literals out of any string
 *    on its way to stdout/stderr or an Error.
 * 2. A pattern scrub for credentials embedded in URLs
 *    (`scheme://user:pass@host`, `scheme://token@host`, `?key=value`,
 *    `#key=value`), which catches secrets that never passed through this
 *    provider — e.g. a connection string written literally in a Launchfile
 *    `env:` value and interpolated into a release command.
 *
 * The registry is process-global on purpose: a command string is assembled in
 * one module and printed in another, so the scrub has to be reachable from the
 * sink without threading a context object through every call site.
 */

export const REDACTED = "[REDACTED]";

/**
 * Values shorter than this are not registered *by inference*. Short strings
 * appear inside unrelated text by coincidence, and scrubbing them would corrupt
 * the output it is meant to protect. Every secret this provider mints is far
 * longer, so the floor never binds on a minted value.
 *
 * The floor is a heuristic, and a heuristic does not overrule an explicit
 * declaration — see `registerDeclaredSecret`.
 */
const MIN_SECRET_LENGTH = 8;

const registry = new Set<string>();

/**
 * Register a value this provider *inferred* is a secret: one it minted itself,
 * or read back out of its own state. Values below `MIN_SECRET_LENGTH` are
 * dropped — nothing declared them sensitive, so a coincidental match would
 * corrupt output for no gain.
 */
export function registerSecret(value: string | undefined | null): void {
	if (typeof value !== "string") return;
	if (value.length < MIN_SECRET_LENGTH) return;
	registry.add(value);
}

/**
 * Register a value something *declared* is a secret: an `env:` literal marked
 * `sensitive: true` (D-18), or a value handed over on the operator channel
 * (D-52). No length floor applies.
 *
 * `sensitive: true` on a six-digit PIN is the author stating that value must be
 * masked. Dropping it for being short writes the PIN to disk in plaintext
 * (CWE-532) — the exact failure this registry exists to prevent. Honouring the
 * declaration costs an over-redacted diagnostic where the value also occurs by
 * chance, which is recoverable; the alternative is a leaked credential, which
 * is not.
 *
 * The empty string is rejected: it is not a credential, and an empty separator
 * would splice `[REDACTED]` between every character of the text.
 */
export function registerDeclaredSecret(value: string | undefined | null): void {
	if (typeof value !== "string" || value === "") return;
	registry.add(value);
}

/** Register many secret values at once. Non-string entries are ignored. */
export function registerSecrets(values: Iterable<string | undefined | null>): void {
	for (const value of values) registerSecret(value);
}

/** Drop every registered secret. Exists for test isolation. */
export function clearRegisteredSecrets(): void {
	registry.clear();
}

// `scheme://user:password@host` — the password group is everything between the
// first `:` after the userinfo and the `@`. Userinfo cannot contain `/`, `@`,
// or whitespace, which bounds the match to a single URL.
//
// The scheme repetition is bounded rather than `*`: unbounded, every starting
// offset in a long run of scheme-legal characters rescans that whole run
// looking for `://`, which is quadratic in the input and lets a log line DoS
// the redactor that is supposed to protect it (CWE-1333).
//
// The bound excludes no URL, and not because schemes are short — RFC 3986 sets
// no ceiling, and `microsoft.windows.camera.multipicker` is 36 characters. It
// is because the pattern is unanchored: against a longer scheme the match
// simply starts further into it and the password still redacts. Raising the
// bound to "fit the longest scheme" would restore the quadratic scan for no
// gain.
const CREDENTIAL_URL =
	/([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s/:@]+:)([^\s/@]+)(@)/g;

// `scheme://token@host` — userinfo with no `:` is a bare credential (a GitHub
// token in the username slot is the usual form), so the whole of it is masked.
// It runs after CREDENTIAL_URL and cannot re-match that output: the userinfo
// group excludes `:`, and `user:[REDACTED]@` has one. A plain username such as
// `ssh://git@host` is masked too — that costs a little diagnostic detail,
// where the alternative leaks a token. The scheme anchor leaves scp-style
// `git@github.com:a/b` alone. Same bounded scheme, same reason as above; the
// userinfo group stops at `/` and `:`, so each `://` scans at most one
// authority.
const USERINFO_URL = /([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/)([^\s/:@]+)(@)/g;

// `?name=value&name=value` — a query string, from its `?` to whitespace, `#`,
// or the next `?`. Every value is masked and every name kept: a list of
// credential parameter names would let the next unlisted one (`sas`,
// `X-Goog-Signature`) through, and a masked value leaks nothing. A parameter
// with no `=` is left as it is, and a fragment is not a query.
//
// The body excludes `?` so the scan stays linear: a run of `?` would otherwise
// let each one rescan the rest of the line (CWE-1333). A query that carries a
// literal `?` is treated as two queries, which masks at least as much. The
// body runs to whitespace, so punctuation that follows a URL in prose is
// masked with the last value rather than risk a value that ends in it.
const URL_QUERY = /\?([^\s#?]*)/g;

// `scheme://...#name=value&name=value` — a fragment's values, masked with the
// same rule as a query (`#access_token=` in an OAuth callback is the usual
// credential). The trigger is a `#` inside a URL token, never a bare `#`, so a
// shell comment, a markdown heading, or a CSS colour in diagnostic text is
// left alone. A fragment with no `=` is kept as it is: that is a D-43 baseline
// ref (`#develop`, `#<sha>`), not a secret, and masking it would hide which
// ref failed to fetch.
//
// Each URL token is matched once, to whitespace, and split at its first `#` in
// the callback, so the scan stays linear. A pattern that looks ahead for the
// `#` (`scheme://[^\s#]*#`) rescans the rest of the token from every `://` in
// it, which is quadratic on `a://a://a://...` (CWE-1333). Same bounded scheme
// as the patterns above.
const URL_TOKEN = /([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/)(\S*)/g;

// A value that already starts with the marker is left alone, so a second
// pass over the same text (an error message re-scrubbed at a later sink) is a
// no-op. The first pass consumed everything up to whitespace, so whatever
// follows the marker was appended after masking, by the code that composed
// the message — the `: 404 Not Found` after a shown URL — and is not the value.
function redactQueryValues(query: string): string {
	return query
		.split("&")
		.map((param) => {
			const eq = param.indexOf("=");
			if (eq === -1 || param.startsWith(REDACTED, eq + 1)) return param;
			return `${param.slice(0, eq)}=${REDACTED}`;
		})
		.join("&");
}

/**
 * Scrub registered secrets and URL-embedded credentials out of `text`.
 *
 * Longest registered values are replaced first so that a secret which is a
 * substring of another (a password inside its own connection URL) cannot leave
 * a partial value behind.
 */
export function redactSecrets(text: string): string {
	let out = text;
	const values = [...registry].sort((a, b) => b.length - a.length);
	for (const value of values) {
		out = out.split(value).join(REDACTED);
	}
	out = out.replace(CREDENTIAL_URL, `$1${REDACTED}$3`);
	out = out.replace(USERINFO_URL, `$1${REDACTED}$3`);
	out = out.replace(
		URL_QUERY,
		(_match, query: string) => `?${redactQueryValues(query)}`,
	);
	return out.replace(URL_TOKEN, (match, scheme: string, rest: string) => {
		const hash = rest.indexOf("#");
		if (hash === -1) return match;
		return `${scheme}${rest.slice(0, hash + 1)}${redactQueryValues(rest.slice(hash + 1))}`;
	});
}
