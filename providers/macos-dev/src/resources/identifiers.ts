/**
 * Guards for values that reach a SQL statement by interpolation.
 *
 * On a first run these values are safe by construction: the database and user
 * names derive from a schema-validated app name, and `generatePassword()`
 * emits base64url. Every later run reuses whatever `.launchfile/state.json`
 * holds, and `loadState()` (state.ts) `JSON.parse`s that file with no
 * validation. The file sits inside the cloned repo, so on the reuse path every
 * value below is attacker-controlled.
 *
 * Argv execution keeps the shell out of these commands; these checks keep the
 * SQL parser out of them. Both are needed: `mysql -e` runs `;`-separated
 * statements and connects as root, so a quote that escapes an identifier or a
 * password literal is a full statement injection with no shell involved.
 */

/** Alphanumeric + underscore — safe as a SQL identifier and as a shell arg. */
export const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** base64url, the exact alphabet `generatePassword()` emits. No quote fits. */
export const SAFE_PASSWORD = /^[A-Za-z0-9_-]+$/;

export function assertSafeIdentifier(value: string, label: string): void {
	if (!SAFE_IDENTIFIER.test(value)) {
		throw new Error(
			`Invalid ${label} in .launchfile/state.json: ${JSON.stringify(value)}`,
		);
	}
}

export function assertSafePassword(value: string): void {
	// The value itself never reaches the message — it is a live credential.
	if (!SAFE_PASSWORD.test(value)) {
		throw new Error(
			"Invalid database password in .launchfile/state.json: expected base64url",
		);
	}
}
