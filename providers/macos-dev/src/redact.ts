/**
 * Secret redaction for anything this provider prints or embeds in an error.
 *
 * Two independent layers, because either alone leaves a hole:
 *
 * 1. A registry of exact secret values. Every generated secret, every
 *    persisted `state.secrets` entry, and every resource password registers
 *    itself at creation/load time; `redactSecrets` then scrubs those literals
 *    out of any string on its way to stdout/stderr or an Error message.
 * 2. A pattern scrub for credentials embedded in URLs
 *    (`scheme://user:pass@host`), which catches secrets that never passed
 *    through this provider — e.g. a connection string written literally in a
 *    Launchfile `env:` value and interpolated into a bootstrap command.
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
export function registerSecrets(
	values: Iterable<string | undefined | null>,
): void {
	for (const value of values) registerSecret(value);
}

/** Drop every registered secret. Exists for test isolation. */
export function clearRegisteredSecrets(): void {
	registry.clear();
}

// `scheme://user:password@host` — the password group is everything between the
// first `:` after the userinfo and the `@`. Userinfo cannot contain `/`, `@`,
// or whitespace, which bounds the match to a single URL.
const CREDENTIAL_URL = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/g;

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
