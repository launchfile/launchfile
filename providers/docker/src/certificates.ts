/**
 * Certificate bindings — activate, or refuse before launch (D-next rule 5).
 *
 * A `provides` entry's `tls:` names a `supports:` entry of type `certificate`
 * on the same component. This provider issues nothing: the certificate arrives
 * through the D-56 supplied-resource channel (`ComposeOpts.resources`), keyed
 * by the entry's `name ?? type` like any other supplied resource, and that
 * arrival IS the selection — the same mechanism every other optional resource
 * uses on this provider (L-6, D-8).
 *
 * Three states, and no fourth:
 *
 * - **not selected** — nothing supplied for that key. The binding is inactive,
 *   its `set_env` never injects, and the component deploys its declared HTTP
 *   baseline. Correct, not degraded: nobody asked for native TLS.
 * - **selected and satisfied** — both `cert_file` and `key_file` supplied. The
 *   binding activates: the entry's effective protocol is `https`, and the
 *   `set_env` wiring goes in after `env:` so it wins (PROVIDERS.md §7).
 * - **selected but unsatisfied** — one of the two properties missing. The
 *   component is REFUSED before launch, naming the entry and what is missing.
 *   Never a fall back to HTTP: a cleartext listener that every sibling URL
 *   addresses as TLS is the silent success the decision exists to forbid.
 *
 * D-56 rule 3 stands throughout: the paths are not opened, parsed, or probed.
 * Whether the bytes behind them are a valid certificate is the supplying
 * party's problem and its own preflight's.
 */

import {
	CERTIFICATE,
	certificateBindings,
	type NormalizedLaunch,
} from "@launchfile/sdk";

/** The two properties a `certificate` entry must supply (D-46 registry). */
const REQUIRED_PROPERTIES = ["cert_file", "key_file"] as const;

/** One component's refusal: the entry, and why it could not activate. */
export interface CertificateRefusal {
	/** The certificate entry's `name ?? type`. */
	certificate: string;
	/** The `provides` entry it binds, as a message names it. */
	endpoint: string;
	/** Properties the supplied resource did not carry. */
	missing: string[];
}

export interface CertificatePlan {
	/**
	 * Certificate names that are selected AND satisfied — the set every
	 * `effectiveListener` reading is taken against.
	 */
	active: Set<string>;
	/** Components that must be refused, in declaration order. */
	refusals: Map<string, CertificateRefusal[]>;
}

/**
 * Decide, for the whole app and before anything is generated, which
 * certificate bindings activate and which components must be refused.
 *
 * Computed up front because `$app.*` is: the app's public URL is derived
 * before the component loop runs, and it has to know whether the primary
 * endpoint's listener speaks `https`.
 */
export function planCertificates(
	launch: NormalizedLaunch,
	resources: Record<string, { properties: Record<string, string> }> | undefined,
): CertificatePlan {
	const active = new Set<string>();
	const refusals = new Map<string, CertificateRefusal[]>();

	for (const [componentName, component] of Object.entries(launch.components)) {
		const declared = new Map<string, string>();
		for (const entry of component.supports ?? []) {
			if (entry.host || entry.type !== CERTIFICATE) continue;
			declared.set(entry.name ?? entry.type, entry.type);
		}

		for (const { entry, certificate } of certificateBindings(component)) {
			// A binding whose certificate is not a `supports: certificate` entry
			// on this component is a validation error the SDK reports; this
			// provider does not second-guess it, and an unresolvable name can
			// never be selected here anyway.
			if (!declared.has(certificate)) continue;
			const supplied = resources?.[certificate];
			if (!supplied) continue; // not selected — the baseline stands (D-8)

			const missing = REQUIRED_PROPERTIES.filter(
				(property) => (supplied.properties[property] ?? "") === "",
			);
			if (missing.length === 0) {
				active.add(certificate);
				continue;
			}
			const list = refusals.get(componentName) ?? [];
			list.push({
				certificate,
				endpoint: entry.name === undefined ? "(unnamed)" : `"${entry.name}"`,
				missing: [...missing],
			});
			refusals.set(componentName, list);
		}
	}

	return { active, refusals };
}

/** The surfaced refusal message for one component (PROVIDERS.md §10 item 5). */
export function certificateRefusalMessage(
	componentName: string,
	refusals: readonly CertificateRefusal[],
): string {
	const entries = refusals
		.map(
			(r) =>
				`${r.certificate} (endpoint ${r.endpoint}): supplied without ${r.missing.join(" or ")}`,
		)
		.join("; ");
	return (
		`refused: ${componentName} selected native TLS and the certificate was not satisfied ` +
		`(${entries}) — component skipped; this provider never falls back to HTTP on a ` +
		"listener a selected certificate was meant to secure (D-next rule 5)"
	);
}
