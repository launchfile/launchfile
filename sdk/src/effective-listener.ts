/**
 * Declared versus effective listener (D-61 rule 2).
 *
 * A `provides` entry's `protocol` and `port` are its **declared** values — the
 * component's own listener in the baseline configuration the file describes
 * (D-59). Its **effective** values are what that listener speaks in the
 * configuration the deployment selected. They are equal unless a bound
 * `certificate` entry is active, in which case the effective protocol is
 * `https` and the effective port is the declared `port:`.
 *
 * One definition, so every consumer answers the question the same way:
 * validation, tooling and the audit surface read the declared values, while
 * every URL-emitting expression derived from a listener reads the effective
 * ones.
 */

import type { Component, Protocol, Provides } from "./types.js";

/** The `supports:` resource type a `tls:` binding names (D-61 rule 1). */
export const CERTIFICATE = "certificate";

/** A `provides` entry's listener, in both readings. */
export interface EffectiveListener {
	/** The `protocol` field as written — the baseline listener (D-59). */
	declaredProtocol: Protocol;
	/** The `port` field as written. */
	declaredPort: number;
	/** What the listener speaks in the selected configuration. */
	protocol: Protocol;
	/**
	 * The port the listener speaks on in the selected configuration. Always
	 * the declared port in this scope — a binding-level override is D-61
	 * Left open (1).
	 */
	port: number;
	/** The certificate this entry binds, if it declares one. */
	certificate?: string;
	/** Whether that binding is active in this deployment. */
	active: boolean;
}

/**
 * The name of the certificate a `provides` entry binds, in either spelling
 * (`tls: server-cert` or `tls: { certificate: server-cert }`), or `undefined`
 * when the entry binds none.
 */
export function boundCertificate(entry: Provides): string | undefined {
	const tls = entry.tls;
	if (tls === undefined) return undefined;
	if (typeof tls === "string") return tls;
	return tls.certificate;
}

/**
 * Read one `provides` entry's listener in both readings.
 *
 * `activeCertificates` names the certificate bindings the deployment selected
 * AND satisfied — the provider's answer, never the file's: an available
 * certificate does not activate a binding (D-61 rule 1, D-8). Omit it and
 * every entry reads as its baseline, which is what a consumer with no
 * selection to report wants.
 */
export function effectiveListener(
	entry: Provides,
	activeCertificates?: ReadonlySet<string> | readonly string[],
): EffectiveListener {
	const certificate = boundCertificate(entry);
	const active =
		certificate !== undefined &&
		activeCertificates !== undefined &&
		(Array.isArray(activeCertificates)
			? activeCertificates.includes(certificate)
			: (activeCertificates as ReadonlySet<string>).has(certificate));
	return {
		declaredProtocol: entry.protocol,
		declaredPort: entry.port,
		protocol: active ? "https" : entry.protocol,
		port: entry.port,
		certificate,
		active,
	};
}

/**
 * Every certificate binding declared on one component, as
 * `provides` entry → certificate name. Empty for the overwhelming majority of
 * components, which declare no `tls:` at all.
 */
export function certificateBindings(
	component: Pick<Component, "provides">,
): Array<{ entry: Provides; certificate: string }> {
	const bindings: Array<{ entry: Provides; certificate: string }> = [];
	for (const entry of component.provides ?? []) {
		const certificate = boundCertificate(entry);
		if (certificate !== undefined) bindings.push({ entry, certificate });
	}
	return bindings;
}
