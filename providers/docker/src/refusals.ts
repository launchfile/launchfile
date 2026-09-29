/**
 * The refusal set — every component this provider refuses before launch, and
 * the surfaced message for each (PROVIDERS.md §10 items 5, 8 and 9).
 *
 * Five causes refuse a component, and the same set answers two questions:
 * which services the compose generator emits nothing for, and whether the
 * app's declared primary is refused, so `$app.*` resolves the empty address
 * (D-72). The set is computed once from the file and the supplied inputs,
 * before `$app.*` is derived, and every verb that resolves `$app.*` — `up`,
 * `bootstrap`, `release` — reads the same function with the same inputs, so
 * the cause of a refusal never changes the address a surviving sibling is
 * handed. Pure: no I/O, and nothing here depends on generator state.
 *
 * Skips are not refusals and are not decided here: a component with no
 * `image` or `build`, and a relative build context with no local source, are
 * left out of the compose file by the generator without entering this set.
 */

import {
	httpsOriginSatisfied,
	type NormalizedLaunch,
	suppliedAppAddress,
	useKeys,
} from "@launchfile/sdk";
import {
	type CertificatePlan,
	certificateRefusalMessage,
	planCertificates,
} from "./certificates.js";
import {
	uncoveredProvisionedUses,
	uncoveredSuppliedUses,
} from "./resource-uses.js";

/** The backing-service type that declares the app's public HTTPS origin (D-60). */
export const HTTPS_ORIGIN = "https-origin";

/**
 * Resource types this provider provisions itself — the factories the compose
 * generator holds. A `requires` entry of any other type is refused unless the
 * supplied-resource channel satisfies it (D-64). `https-origin` is not a
 * factory: the publication context is its channel (D-60 rule 5).
 */
export const PROVISIONED_TYPES: ReadonlySet<string> = new Set([
	"postgres",
	"mysql",
	"mariadb",
	"redis",
	"mongodb",
	"clickhouse",
	"elasticsearch",
	"minio",
	"s3",
	"memcache",
	"rabbitmq",
	"kafka",
]);

/** A supplied resource as the D-56 channel delivers it (`ComposeOpts.resources`). */
export type SuppliedResources = Record<
	string,
	{ properties: Record<string, string> }
>;

/** The inputs the refusal set is decided on — the ones `up` decides it on. */
export interface RefusalInputs {
	/** The effective publication context (D-58), normalized or `undefined`. */
	appUrl?: string;
	/** Resources supplied through the D-56 channel, keyed by `name ?? type`. */
	resources?: SuppliedResources;
	/**
	 * The certificate plan for the same `resources`, when the caller already
	 * holds it; otherwise it is planned here.
	 */
	certificates?: CertificatePlan;
}

/**
 * The surfaced refusal for a component with a `requires` entry this provider
 * has no factory for and nothing supplied (PROVIDERS.md §10 item 5, D-64).
 * Names the component, each entry, and both ways out. It states what this
 * provider does and asserts nothing about the app or another provider.
 */
function unprovisionableResourceRefusal(
	componentName: string,
	entries: readonly string[],
): string {
	const noun = entries.length === 1 ? "a resource" : "resources";
	return (
		`refused: ${componentName} requires ${noun} this provider cannot provision ` +
		`(${entries.join("; ")}) — this provider has no provisioner for the type; supply it ` +
		"through the provider's supplied-resource channel (D-56) or use a provider that " +
		"provisions it — component skipped"
	);
}

/**
 * The surfaced refusal for a component with a `requires` entry declaring a
 * use this provider cannot cover (SPEC.md § Resource uses, D-56 rule 1, D-64).
 * Names the component, each entry and use, and the way out.
 */
function uncoveredUseRefusal(
	componentName: string,
	entries: readonly string[],
): string {
	const noun = entries.length === 1 ? "a use" : "uses";
	return (
		`refused: ${componentName} requires ${noun} of a resource this provider cannot cover ` +
		`(${entries.join("; ")}) — a provider covers every declared use or refuses; declare only ` +
		"what the app uses, supply a resource that covers it through the provider's " +
		"supplied-resource channel (D-56), or use a provider that covers it — component skipped"
	);
}

/**
 * Why one component is refused, or `undefined` when it is not. The causes
 * are graded in a fixed order and the first one found is the message: a
 * component refused for two reasons is refused once, and the message names
 * the earliest cause.
 *
 * 1. Host capabilities (D-44, PROVIDERS.md §11): this provider grants none,
 *    so a required one — the `host:` entry form or the legacy block — refuses.
 * 2. A required `https-origin` the publication context does not satisfy
 *    (D-60 rule 5): no URL, or one whose scheme is not `https`.
 * 3. A selected certificate binding that is not satisfied (D-61 rule 5).
 * 4. A required type with no factory here and nothing supplied (D-64).
 * 5. A required use this provider cannot cover (D-65 rule 3): a supplied
 *    resource whose map lacks the use's registered properties, a use no
 *    factory here hands over, or a token this provider does not recognise.
 */
function componentRefusal(
	componentName: string,
	component: NormalizedLaunch["components"][string],
	inputs: RefusalInputs,
	certificates: CertificatePlan,
): string | undefined {
	const refusedCapabilities: string[] = [];
	for (const req of component.requires ?? []) {
		if (!req.host) continue;
		for (const [capability, value] of Object.entries(req.host)) {
			refusedCapabilities.push(`${capability}=${String(value)}`);
		}
	}
	if (component.host?.docker === "required") {
		refusedCapabilities.push(
			"container_runtime=docker (host.docker: required)",
		);
	}
	if (component.host?.network === "host") {
		refusedCapabilities.push("network=host (host.network: host)");
	}
	if (component.host?.privileged) {
		refusedCapabilities.push("privileged=true (host.privileged)");
	}
	if (refusedCapabilities.length > 0) {
		return (
			`refused: ${componentName} requires host capabilities this provider cannot grant ` +
			`(${refusedCapabilities.join("; ")}) — component skipped`
		);
	}

	const refusedOrigins: string[] = [];
	if (!httpsOriginSatisfied(inputs.appUrl)) {
		for (const req of component.requires ?? []) {
			if (req.type !== HTTPS_ORIGIN) continue;
			const entry = `${req.name ?? req.type} (endpoint "${req.endpoint ?? "?"}")`;
			// The scheme is read off the supplied URL itself: `$app.scheme`
			// is `""` once this refusal empties the primary's address.
			refusedOrigins.push(
				inputs.appUrl === undefined
					? `${entry}: no publication URL was supplied, and this provider has no edge of its own`
					: `${entry}: the supplied publication URL's scheme is "${suppliedAppAddress(inputs.appUrl).scheme}", not https`,
			);
		}
	}
	if (refusedOrigins.length > 0) {
		return (
			`refused: ${componentName} requires a public HTTPS origin this provider cannot supply ` +
			`(${refusedOrigins.join("; ")}) — component skipped`
		);
	}

	const certificateRefusals = certificates.refusals.get(componentName);
	if (certificateRefusals) {
		return certificateRefusalMessage(componentName, certificateRefusals);
	}

	const unprovisionable: string[] = [];
	for (const req of component.requires ?? []) {
		if (req.host || req.type === HTTPS_ORIGIN) continue;
		if (inputs.resources?.[req.name ?? req.type]) continue;
		if (PROVISIONED_TYPES.has(req.type)) continue;
		unprovisionable.push(
			req.name === undefined ? req.type : `${req.name} (type "${req.type}")`,
		);
	}
	if (unprovisionable.length > 0) {
		return unprovisionableResourceRefusal(componentName, unprovisionable);
	}

	const uncoveredUses: string[] = [];
	for (const req of component.requires ?? []) {
		if (req.host || !req.uses) continue;
		const resourceName = req.name ?? req.type;
		const supplied = inputs.resources?.[resourceName];
		const uncovered = supplied
			? uncoveredSuppliedUses(req.type, useKeys(req.uses), supplied.properties)
			: uncoveredProvisionedUses(req.type, useKeys(req.uses));
		for (const detail of uncovered) {
			uncoveredUses.push(`${resourceName}: ${detail}`);
		}
	}
	if (uncoveredUses.length > 0) {
		return uncoveredUseRefusal(componentName, uncoveredUses);
	}

	return undefined;
}

/**
 * Every component this provider refuses, in declaration order, mapped to the
 * surfaced message for it. Empty when nothing is refused.
 *
 * The one refusal set: the compose generator applies it (a refused component
 * gets no service and its message goes to `warnings`), and `$app.*` reads it
 * (a refused declared primary resolves the empty address, D-72). `bootstrap`
 * and `release` compute it from the same inputs, so all three verbs give one
 * answer. A `supports:` entry never refuses (D-8); its component enters this
 * set only through a `requires` entry or a selected certificate.
 */
export function refusedComponents(
	launch: NormalizedLaunch,
	inputs: RefusalInputs = {},
): Map<string, string> {
	const certificates =
		inputs.certificates ?? planCertificates(launch, inputs.resources);
	const refused = new Map<string, string>();
	for (const [componentName, component] of Object.entries(launch.components)) {
		const message = componentRefusal(
			componentName,
			component,
			inputs,
			certificates,
		);
		if (message !== undefined) refused.set(componentName, message);
	}
	return refused;
}
