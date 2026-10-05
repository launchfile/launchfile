/**
 * The refusal set — every component this provider refuses before launch
 * (PROVIDERS.md §10 items 5 and 9, §11), graded by cause.
 *
 * Five causes refuse a component, and `up` removes each refused one from the
 * run with a surfaced message (`apply*Refusals` in `provider.ts`). The same
 * set decides whether the app's declared primary is refused, so `$app.*`
 * resolves the empty address whatever the cause (D-72): `up` computes
 * {@link refusedComponents} before its refusals remove anything, and `env`
 * and `bootstrap` compute it from the file whole with the inputs `up`
 * recorded (publication context, `--with-optional`), so the three verbs give
 * one answer. Pure: no I/O.
 *
 * A component outside the operator's start-set is not refused — it is not
 * selected — and is not graded here.
 */

import {
	CERTIFICATE,
	certificateBindings,
	httpsOriginSatisfied,
	type NormalizedLaunch,
	useKeys,
} from "@launchfile/sdk";
import { HTTPS_ORIGIN, httpsOriginShortfall } from "./https-origin.js";
import { getProvisioner, uncoveredUses } from "./resources/index.js";

/**
 * Components this provider must refuse, mapped to the capabilities it cannot
 * grant (D-44, PROVIDERS.md §11). Both spellings fold together so the `host:`
 * entry form and the legacy top-level block produce the same outcome.
 *
 * A refusal must remove the component from the run, not merely report it —
 * this provider grants no host capabilities, so anything listed here cannot
 * be installed, wired, registered, or started.
 */
export function refusedHostCapabilities(
	launch: NormalizedLaunch,
): Map<string, string[]> {
	const refused = new Map<string, string[]>();
	for (const [name, c] of Object.entries(launch.components)) {
		const caps: string[] = [];
		for (const req of c.requires ?? []) {
			for (const [capability, value] of Object.entries(req.host ?? {})) {
				caps.push(`${capability}=${String(value)}`);
			}
		}
		if (c.host?.docker === "required")
			caps.push("container_runtime=docker (host.docker)");
		if (c.host?.network === "host") caps.push("network=host (host.network)");
		if (c.host?.privileged) caps.push("privileged=true (host.privileged)");
		if (caps.length > 0) refused.set(name, caps);
	}
	return refused;
}

/**
 * Components this provider must refuse because they require a public HTTPS
 * origin it cannot supply (D-60 rule 5), mapped to the entries and the reason.
 *
 * This provider has no edge of its own, so it cannot provision the origin. It
 * can accept one through the publication-context channel (`appUrl`, D-58) —
 * which for this type IS the supplied-resource channel (PROVIDERS.md §7) —
 * when the URL's scheme is `https`; then the entry is satisfied and nothing is
 * refused. With no URL, or one whose scheme is not `https`, the entry cannot
 * be satisfied and refusing is what PROVIDERS.md §10 item 5 makes conformant.
 * `supports:` entries are never refused: the component runs, degraded.
 *
 * `appUrl` is the effective publication URL — supplied on this run or recorded
 * by an earlier one — normalized.
 */
export function refusedHttpsOrigins(
	launch: NormalizedLaunch,
	appUrl?: string,
): Map<string, string[]> {
	const refused = new Map<string, string[]>();
	if (httpsOriginSatisfied(appUrl)) return refused;
	for (const [name, c] of Object.entries(launch.components)) {
		const entries = (c.requires ?? [])
			.filter((r) => r.type === HTTPS_ORIGIN)
			.map((r) => httpsOriginShortfall(r, appUrl));
		if (entries.length > 0) refused.set(name, entries);
	}
	return refused;
}

/**
 * Components this provider must refuse because native TLS was selected on a
 * listener it cannot activate (D-61 rule 5), mapped to the entries.
 *
 * Selection on this provider is `--with-optional`: it is the only way a
 * `supports:` entry is ever turned on here. Without the flag a certificate
 * binding is simply inactive and the component runs its declared HTTP
 * baseline, which is correct (D-8) — so this returns nothing.
 *
 * With the flag, the operator asked for the optional capability and this
 * provider has no way to deliver it: it has no supplied-resource channel to
 * receive `cert_file`/`key_file` through, and no certificate of its own to
 * offer. Refusing is what PROVIDERS.md §10 item 5 makes conformant; falling
 * back to HTTP on a listener the operator asked to secure is the silent
 * success the decision forbids.
 */
export function refusedCertificates(
	launch: NormalizedLaunch,
	withOptional: boolean,
): Map<string, string[]> {
	const refused = new Map<string, string[]>();
	if (!withOptional) return refused;
	for (const [name, component] of Object.entries(launch.components)) {
		const declared = new Set(
			(component.supports ?? [])
				.filter((s) => !s.host && s.type === CERTIFICATE)
				.map((s) => s.name ?? s.type),
		);
		const entries = certificateBindings(component)
			.filter(({ certificate }) => declared.has(certificate))
			.map(
				({ entry, certificate }) =>
					`${certificate} (endpoint ${entry.name === undefined ? "(unnamed)" : `"${entry.name}"`})`,
			);
		if (entries.length > 0) refused.set(name, entries);
	}
	return refused;
}

/**
 * Components this provider must refuse because a `requires` entry names a
 * resource type it has no provisioner for (PROVIDERS.md §10 item 5, D-64),
 * mapped to the entries. The ordinary case of {@link refusedHttpsOrigins}: a
 * `kafka` this provider cannot stand up is exactly a `postgres` it cannot
 * stand up.
 *
 * This provider has no supplied-resource channel, so nothing can satisfy such
 * an entry from outside — provision or refuse are its only conformant
 * outcomes. The vocabulary is open (L-4): a type with no provisioner is a
 * normal, permanent state, and the defect is starting the component without
 * the resource its file says it needs. Host-capability entries take rule 9's
 * path and `supports:` entries are optional (D-8); neither is graded here.
 */
export function refusedResourceTypes(
	launch: NormalizedLaunch,
): Map<string, string[]> {
	const refused = new Map<string, string[]>();
	for (const [name, component] of Object.entries(launch.components)) {
		const entries = (component.requires ?? [])
			.filter(
				(r) => !r.host && r.type !== HTTPS_ORIGIN && !getProvisioner(r.type),
			)
			.map((r) =>
				r.name === undefined ? r.type : `${r.name} (type "${r.type}")`,
			);
		if (entries.length > 0) refused.set(name, entries);
	}
	return refused;
}

/**
 * Components this provider must refuse because a `requires` entry declares a
 * use its provisioner cannot cover (SPEC.md § Resource uses, D-56 rule 1,
 * D-64), mapped to `<entry>: <use>` lines. Graded after
 * {@link refusedResourceTypes}: a type with no provisioner is refused on the
 * type, so only entries whose type this provider stands up, or accepts
 * through the publication context (`https-origin`), reach here. A
 * token this provider does not recognise is uncovered — no provider can
 * claim to cover a use it does not know. `supports:` entries are optional
 * (D-8) and are not graded here.
 */
export function refusedResourceUses(
	launch: NormalizedLaunch,
): Map<string, string[]> {
	const refused = new Map<string, string[]>();
	for (const [name, component] of Object.entries(launch.components)) {
		const entries: string[] = [];
		for (const req of component.requires ?? []) {
			if (req.host || !req.uses) continue;
			if (req.type !== HTTPS_ORIGIN && !getProvisioner(req.type)) continue;
			const resourceName = req.name ?? req.type;
			for (const use of uncoveredUses(req.type, useKeys(req.uses))) {
				entries.push(`${resourceName}: ${use}`);
			}
		}
		if (entries.length > 0) refused.set(name, entries);
	}
	return refused;
}

/** The inputs the refusal set is decided on — the ones `up` decides it on. */
export interface RefusalInputs {
	/** The effective publication context (D-58), normalized or `undefined`. */
	appUrl?: string;
	/**
	 * `--with-optional`: the only way a certificate binding is selected on
	 * this provider (D-61 rule 5). `up` records it in state, and `env` and
	 * `bootstrap` pass the recorded value. Absent reads as `false`.
	 */
	withOptional?: boolean;
}

/**
 * Every component this provider refuses, for any of the five causes. The
 * union of the per-cause helpers above over the whole file — each grades a
 * component on its own entries, so the union is exactly the set the
 * sequential `apply*Refusals` calls in `up` remove.
 */
export function refusedComponents(
	launch: NormalizedLaunch,
	inputs: RefusalInputs = {},
): Set<string> {
	return new Set([
		...refusedHostCapabilities(launch).keys(),
		...refusedHttpsOrigins(launch, inputs.appUrl).keys(),
		...refusedCertificates(launch, inputs.withOptional === true).keys(),
		...refusedResourceTypes(launch).keys(),
		...refusedResourceUses(launch).keys(),
	]);
}
