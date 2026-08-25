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

/** Property names that are credentials wherever they appear (D-46 registry). */
const CREDENTIAL_PROPERTIES = new Set(["password", "secret_key", "access_key"]);

/**
 * Structural property names whose values are addresses and identifiers, not
 * credentials. These are exempt from registration: scrubbing "localhost" or
 * "5432" out of every diagnostic would corrupt the output redaction exists to
 * protect. A URL with embedded credentials stays covered by the redactor's
 * pattern scrub (`scheme://user:pass@host`).
 */
const STRUCTURAL_PROPERTIES = new Set([
	"host",
	"port",
	"name",
	"user",
	"url",
	"bucket",
	"region",
]);

/**
 * Register the credential-bearing properties of one orchestrator-supplied
 * resource (`ComposeOpts.resources`). Same reasoning as `registerSuppliedEnv`:
 * these are values this provider never minted, handed over before anything
 * resolves, so nothing else can have registered them.
 *
 * Unlike the env channel, indiscriminate registration is wrong here — a
 * resource property map carries hostnames and ports alongside its credentials.
 * Classification is by property name against the D-46 vocabulary:
 * `password`/`secret_key`/`access_key` always register; the structural set is
 * exempt; any name outside the type's registry vocabulary registers too (fail
 * closed — an extension property this provider cannot classify is treated as a
 * credential, never assumed benign).
 */
export function registerSuppliedResourceProperties(
	properties: Readonly<Record<string, string>>,
	vocabulary: readonly string[] | undefined,
): void {
	for (const [prop, value] of Object.entries(properties)) {
		if (CREDENTIAL_PROPERTIES.has(prop)) {
			registerDeclaredSecret(value);
			continue;
		}
		if (STRUCTURAL_PROPERTIES.has(prop)) continue;
		if (vocabulary?.includes(prop)) continue;
		registerDeclaredSecret(value);
	}
}
