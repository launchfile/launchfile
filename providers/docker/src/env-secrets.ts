/**
 * Registers the credential-bearing env values this provider does not generate.
 *
 * The secret registry (`redact.ts`) started out covering only provider-*minted*
 * values and persisted state, which leaves two classes of real credential
 * unscrubbable:
 *
 * 1. A literal `env:` value the author marked `sensitive: true` (D-18). The
 *    D-18 obligation is "masked in logs and UI" — an author-declared API key is
 *    exactly the value a failing container echoes back in the error that killed
 *    the launch.
 * 2. An operator-supplied value for a `required:` declaration (D-52). Same
 *    reasoning, opposite origin: the platform never saw it before the operator
 *    handed it over, so nothing else can have registered it.
 *
 * Both must be registered *before* any output is captured, or the capture writes
 * plaintext credentials to disk (CWE-532, CWE-312).
 *
 * Both register through `registerDeclaredSecret`, which has no length floor.
 * These values are sensitive because something said so, not because this
 * provider guessed — and `registerSecret`'s floor would silently drop a short
 * one (a PIN, a numeric code) straight into a record.
 */

import type { NormalizedEnvVar } from "@launchfile/sdk";
import { registerDeclaredSecret } from "./redact.js";

/**
 * Register the resolved values of every `sensitive: true` declaration in one
 * component's env. `resolved` is the post-resolution map the generator is about
 * to write into the compose file.
 */
export function registerSensitiveEnv(
	declared: Readonly<Record<string, NormalizedEnvVar>> | undefined,
	resolved: Readonly<Record<string, string>>,
): void {
	if (!declared) return;
	for (const [key, definition] of Object.entries(declared)) {
		if (!definition?.sensitive) continue;
		registerDeclaredSecret(resolved[key]);
	}
}

/**
 * Register every value an operator supplied for this component (D-52). The
 * operator channel is a value the platform cannot classify, so all of it is
 * treated as credential material.
 */
export function registerSuppliedEnv(
	supplied: Readonly<Record<string, string>> | undefined,
): void {
	if (!supplied) return;
	for (const value of Object.values(supplied)) registerDeclaredSecret(value);
}
