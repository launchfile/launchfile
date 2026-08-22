/**
 * Secret redaction for anything this provider prints or embeds in an error.
 *
 * Mirrors `providers/macos-dev/src/redact.ts` — same API, same two layers, so
 * the two reference providers handle credentials the same way (P-5) and the
 * D-18 obligation ("mask it in logs and UI") is met on both:
 *
 * 1. A registry of exact secret values. Every generated password/secret and
 *    every persisted `state.secrets` entry registers itself at
 *    creation/load time, and every `secrets` map handed to the release
 *    planner registers its values; `redactSecrets` then scrubs those
 *    literals out of any string on its way to stdout/stderr or an Error.
 * 2. A pattern scrub for credentials embedded in URLs
 *    (`scheme://user:pass@host`), which catches secrets that never passed
 *    through this provider — e.g. a connection string written literally in a
 *    Launchfile `env:` value and interpolated into a release command.
 *
 * The registry is process-global on purpose: a command string is assembled in
 * one module and printed in another, so the scrub has to be reachable from the
 * sink without threading a context object through every call site.
 */

export const REDACTED = "[REDACTED]";

/**
 * Values shorter than this are not registered. Short strings appear inside
 * unrelated text by coincidence, and scrubbing them would corrupt the output
 * it is meant to protect. Every secret this provider generates is far longer.
 */
const MIN_SECRET_LENGTH = 8;

const registry = new Set<string>();

/** Register a secret value so it is scrubbed from all future output. */
export function registerSecret(value: string | undefined | null): void {
	if (typeof value !== "string") return;
	if (value.length < MIN_SECRET_LENGTH) return;
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
// the redactor that is supposed to protect it (CWE-1333). RFC 3986 schemes are
// ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ); the longest IANA-registered one
// is well under this bound, so nothing real is excluded.
const CREDENTIAL_URL =
	/([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s/:@]+:)([^\s/@]+)(@)/g;

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
	return out.replace(CREDENTIAL_URL, `$1${REDACTED}$3`);
}
