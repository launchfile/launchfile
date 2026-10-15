/**
 * Host capabilities — the grant/refuse fulfillment mode (D-44, D-53,
 * PROVIDERS.md §11).
 *
 * The generator itself grants nothing: handing an app the host's runtime
 * socket, host network, or privileged mode from inside a managed compose
 * project defeats its isolation model. A caller that CAN grant safely — an
 * operator's own machine, after explicit consent (SPEC.md "Host capabilities
 * require user consent") — supplies a policy. The policy answers one request
 * per capability entry and returns the compose service fields that grant it,
 * or a reason to refuse. Without a policy, or when the policy refuses, a
 * required entry refuses the component exactly as before.
 */

import type { Component, HostCapability } from "@launchfile/sdk";

/** The `host:` map of a capability entry; a bare-string or `type:` entry has none. */
function hostOf(entry: unknown): HostCapability["host"] | undefined {
	if (typeof entry !== "object" || entry === null || !("host" in entry))
		return undefined;
	const host = (entry as { host?: unknown }).host;
	return typeof host === "object" && host !== null
		? (host as HostCapability["host"])
		: undefined;
}

/** One capability entry on one component, as the Launchfile declared it. */
export interface HostCapabilityRequest {
	/** The component the entry belongs to. */
	component: string;
	/** `requires`: grant it or the component is refused. `supports`: optional. */
	mode: "requires" | "supports";
	/**
	 * The entry's `host:` map. The legacy top-level `host:` block arrives in the
	 * same spelling (`container_runtime`, `network`, `filesystem`,
	 * `privileged`) so a policy sees one vocabulary.
	 */
	capabilities: Record<string, string | boolean>;
}

/**
 * The compose service fields a grant may set. Nothing else: the generator
 * owns image, build, env, ports, volumes and networking, and a grant must not
 * reach past the capability it answers. List fields are unioned with what
 * the generator emitted; scalar fields win over nothing (the generator never
 * sets them).
 */
export interface HostCapabilityGrant {
	privileged?: boolean;
	cap_add?: string[];
	cap_drop?: string[];
	security_opt?: string[];
	sysctls?: Record<string, string>;
	devices?: string[];
	/** Host paths or named volumes to mount, in compose `volumes:` short syntax. */
	volumes?: string[];
	user?: string;
	read_only?: boolean;
	tmpfs?: string[];
	pids_limit?: number;
	mem_limit?: string;
	cpus?: string;
	network_mode?: string;
	/**
	 * What was granted, in the caller's words, for the launch report
	 * (PROVIDERS.md §10 rule 8: a grant is as visible as a refusal).
	 */
	summary?: string;
}

export type HostCapabilityDecision =
	| { granted: HostCapabilityGrant }
	| { refused: string };

/** Answers every host capability request of a launch. */
export type HostCapabilityPolicy = (
	request: HostCapabilityRequest,
) => HostCapabilityDecision;

/** What one component's capability entries resolve to. */
export interface HostCapabilityOutcome {
	/** Formatted `name=value` lists of every required entry that was refused, one string per entry. */
	refused: string[];
	/** Grants to apply, required and optional alike. */
	grants: HostCapabilityGrant[];
	/** Launch-report lines: optional entries left ungranted, and every grant's summary. */
	notes: string[];
}

function formatCapabilities(
	capabilities: Record<string, string | boolean>,
): string {
	return Object.entries(capabilities)
		.map(([capability, value]) => `${capability}=${String(value)}`)
		.join("; ");
}

/** The legacy block's keys, as the entry spelling a policy sees. */
function legacyBlockCapabilities(
	component: Component,
): Record<string, string | boolean> {
	const capabilities: Record<string, string | boolean> = {};
	if (component.host?.docker === "required")
		capabilities.container_runtime = "docker";
	if (component.host?.network === "host") capabilities.network = "host";
	if (component.host?.filesystem && component.host.filesystem !== "none")
		capabilities.filesystem = component.host.filesystem;
	if (component.host?.privileged) capabilities.privileged = true;
	return capabilities;
}

/**
 * Collect every capability entry of `component` — `requires`, the legacy
 * block, `supports` — and put each to the policy. No policy means every
 * required entry is refused and every optional one is left ungranted, which
 * is this provider's own answer.
 */
export function resolveHostCapabilities(
	componentName: string,
	component: Component,
	policy: HostCapabilityPolicy | undefined,
): HostCapabilityOutcome {
	const outcome: HostCapabilityOutcome = { refused: [], grants: [], notes: [] };

	const requests: HostCapabilityRequest[] = [];
	for (const req of component.requires ?? []) {
		const host = hostOf(req);
		if (!host) continue;
		requests.push({
			component: componentName,
			mode: "requires",
			capabilities: host,
		});
	}
	const legacy = legacyBlockCapabilities(component);
	if (Object.keys(legacy).length > 0) {
		requests.push({
			component: componentName,
			mode: "requires",
			capabilities: legacy,
		});
	}
	for (const sup of component.supports ?? []) {
		const host = hostOf(sup);
		if (!host) continue;
		requests.push({
			component: componentName,
			mode: "supports",
			capabilities: host,
		});
	}

	for (const request of requests) {
		const listed = formatCapabilities(request.capabilities);
		const decision = policy?.(request);
		if (decision && "granted" in decision) {
			outcome.grants.push(decision.granted);
			outcome.notes.push(
				`${componentName}: host capability ${listed} granted` +
					(decision.granted.summary ? ` — ${decision.granted.summary}` : ""),
			);
			continue;
		}
		const reason =
			decision && "refused" in decision ? decision.refused : undefined;
		if (request.mode === "requires") {
			outcome.refused.push(reason ? `${listed}: ${reason}` : listed);
		} else {
			outcome.notes.push(
				`${componentName}: optional host capability ${listed} ` +
					"not granted — its set_env vars are omitted and the app runs degraded",
			);
		}
	}
	return outcome;
}

const LIST_FIELDS = [
	"cap_add",
	"cap_drop",
	"security_opt",
	"devices",
	"volumes",
	"tmpfs",
] as const;
const SCALAR_FIELDS = [
	"privileged",
	"user",
	"read_only",
	"pids_limit",
	"mem_limit",
	"cpus",
	"network_mode",
] as const;

/** Merge every grant into the assembled compose service, union for lists. */
export function applyHostCapabilityGrants(
	service: Record<string, unknown>,
	grants: HostCapabilityGrant[],
): void {
	for (const grant of grants) {
		for (const field of LIST_FIELDS) {
			const additions = grant[field];
			if (!additions?.length) continue;
			const existing = Array.isArray(service[field])
				? (service[field] as string[])
				: [];
			service[field] = [
				...existing,
				...additions.filter((v) => !existing.includes(v)),
			];
		}
		if (grant.sysctls && Object.keys(grant.sysctls).length > 0) {
			const existing =
				service.sysctls && typeof service.sysctls === "object"
					? (service.sysctls as Record<string, string>)
					: {};
			service.sysctls = { ...existing, ...grant.sysctls };
		}
		for (const field of SCALAR_FIELDS) {
			if (grant[field] !== undefined) service[field] = grant[field];
		}
	}
}
