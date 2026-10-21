/**
 * `requires[].version` reporting for the resource provisioners (PROVIDERS.md
 * §10 item 8, D-74). This provider never selects a version: it uses the
 * Homebrew service it finds running, or the formula it installs. A declared
 * range is compared, through the SDK's shared comparison, with the version the
 * running server reports. A range that version satisfies is honored and stays
 * silent; anything else is returned as a warning for `up` to print.
 *
 * The warning states what this provider does and never what the app will do
 * (the D-51 constraint).
 */

import { checkVersionRange, type NormalizedRequirement } from "@launchfile/sdk";

/**
 * The first `major.minor[.patch]` in a server's version output, as a semver
 * version — `"16.4 (Homebrew)"` → `"16.4.0"`, `"11.4.2-MariaDB"` → `"11.4.2"`.
 * `undefined` when the output carries none.
 */
export function serverVersion(output: string): string | undefined {
	const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
	if (!match) return undefined;
	return `${match[1]}.${match[2]}.${match[3] ?? "0"}`;
}

/**
 * The warning a declared `requires[].version` earns, or `undefined` when there
 * is none to give: no version declared, or the running version satisfies it.
 *
 * `server` names what this provider runs ("the PostgreSQL server on
 * localhost:5432"). `running` is the version it reported, `undefined` when
 * none was read. `unread` replaces the reason given when no version is known.
 */
export function versionWarning(
	req: NormalizedRequirement,
	server: string,
	running: string | undefined,
	unread = `read no ${req.type} version from ${server}`,
): string | undefined {
	const declared = req.version;
	if (!declared) return undefined;
	const head = `requires[${req.name ?? req.type}]: declared version ${JSON.stringify(declared)}`;

	switch (checkVersionRange(declared, running)) {
		case "satisfied":
			return undefined;
		case "invalid":
			return `${head} is not a valid semver range — this provider cannot check it against ${server}.`;
		case "unknown":
			return `${head} cannot be checked — this provider does not select versions and ${unread}.`;
		case "unsatisfied":
			return `${head} is not satisfied — this provider uses ${server}, version ${running}, and does not select versions.`;
		case "undecidable":
			return `${head} cannot be checked against ${server}, version ${running} — this provider does not select versions.`;
	}
}
