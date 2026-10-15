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
 * required entry refuses the component. Legacy `host:` block keys are refused
 * the same way, including `filesystem:`.
 */

import {
	type NormalizedComponent,
	type NormalizedRequirement,
	stripControlInline,
} from "@launchfile/sdk";

/** One capability entry on one component, as the Launchfile declared it. */
export interface HostCapabilityRequest {
	/** The component the entry belongs to. */
	component: string;
	/** `requires`: grant it or the component is refused. `supports`: optional. */
	mode: "requires" | "supports";
	/**
	 * The entry's `host:` map. Each key of the legacy top-level `host:` block
	 * arrives as its own request in the entry spelling (`container_runtime`,
	 * `network`, `filesystem`, `privileged`), exactly as SPEC.md § Migrating off
	 * the `host:` block maps it, so a policy sees one vocabulary and decides
	 * each key once.
	 */
	capabilities: Record<string, string | boolean>;
}

/**
 * The compose service fields a grant may set. List fields are unioned with
 * what the generator emitted. Scalar fields overwrite, and the last grant wins.
 * A grant that would make the service invalid (a named volume, or a second
 * mount on a container path already mounted) refuses the entry with that
 * reason. A `network_mode` grant replaces the project network for that service.
 */
export interface HostCapabilityGrant {
	privileged?: boolean;
	cap_add?: string[];
	cap_drop?: string[];
	security_opt?: string[];
	sysctls?: Record<string, string>;
	devices?: string[];
	/**
	 * Host paths to mount, in compose `volumes:` short syntax
	 * (`/host/path:/container/path[:mode]`). A named-volume source is refused:
	 * the generated project declares no volume for it.
	 */
	volumes?: string[];
	user?: string;
	read_only?: boolean;
	tmpfs?: string[];
	pids_limit?: number;
	mem_limit?: string;
	cpus?: string;
	network_mode?: string;
	/**
	 * The capability's coordinates as granted (`socket`, `url`, `api` for
	 * `container_runtime`). The entry's `set_env` resolves `$<property>`
	 * against this map. A property `set_env` reads that the grant does not
	 * supply refuses the entry — the provider never wires an empty value in
	 * its place (D-52).
	 */
	properties?: Record<string, string>;
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
	/**
	 * The granted coordinates of each granted `requires`/`supports` entry,
	 * keyed by the entry object, for its `set_env` wiring. An entry absent here
	 * was not granted, and its `set_env` stays unwired.
	 */
	properties: Map<NormalizedRequirement, Record<string, string>>;
	/** Launch-report lines: optional entries left ungranted, and every grant (`granted:` prefix). */
	notes: string[];
}

/**
 * Names the properties an entry's `set_env` reads that `properties` lacks.
 * The generator supplies it, because expression semantics are its own.
 */
export type UnsuppliedProperties = (
	entry: NormalizedRequirement,
	properties: Record<string, string>,
) => string[];

/** Policy-supplied text, made safe for a one-line launch report. */
function policyText(text: string): string {
	return stripControlInline(text);
}

interface PendingRequest {
	request: HostCapabilityRequest;
	/** The entry carrying `set_env`; absent for a legacy block key. */
	entry?: NormalizedRequirement;
	/** Each capability as the report names it, one per key. */
	labels: string[];
}

/**
 * One request per key of the legacy block, in the migration table's entry
 * spelling and mood. The report keeps the block spelling as a suffix, so an
 * operator can find the key in the file.
 */
function legacyBlockRequests(
	componentName: string,
	component: NormalizedComponent,
): PendingRequest[] {
	const host = component.host;
	if (!host) return [];
	const keys: Array<{
		mode: "requires" | "supports";
		capability: string;
		value: string | boolean;
		spelling: string;
	}> = [];
	if (host.docker === "required" || host.docker === "optional") {
		keys.push({
			mode: host.docker === "required" ? "requires" : "supports",
			capability: "container_runtime",
			value: "docker",
			spelling: `host.docker: ${host.docker}`,
		});
	}
	if (host.network === "host") {
		keys.push({
			mode: "requires",
			capability: "network",
			value: "host",
			spelling: "host.network: host",
		});
	}
	if (host.filesystem && host.filesystem !== "none") {
		keys.push({
			mode: "requires",
			capability: "filesystem",
			value: host.filesystem,
			spelling: `host.filesystem: ${host.filesystem}`,
		});
	}
	if (host.privileged) {
		keys.push({
			mode: "requires",
			capability: "privileged",
			value: true,
			spelling: "host.privileged",
		});
	}
	return keys.map(({ mode, capability, value, spelling }) => ({
		request: {
			component: componentName,
			mode,
			capabilities: { [capability]: value },
		},
		labels: [`${capability}=${String(value)} (${spelling})`],
	}));
}

/** The compose short-syntax volume entry, split into source and target. */
function parseVolume(entry: string): { source?: string; target: string } {
	const parts = entry.split(":");
	if (parts.length === 1) return { target: normalizeTarget(parts[0] ?? "") };
	return {
		source: parts[0],
		target: normalizeTarget(parts[1] ?? ""),
	};
}

function normalizeTarget(target: string): string {
	return target.length > 1 ? target.replace(/\/+$/, "") : target;
}

/** A host-path source; anything else in the source slot names a volume. */
function isHostPath(source: string): boolean {
	return (
		source.startsWith("/") || source.startsWith(".") || source.startsWith("~")
	);
}

/** Container path → the `volumes:` entry mounting it (undefined: not a compose entry). */
type MountedTargets = Map<string, string | undefined>;

function mountedTargets(entries: readonly string[]): MountedTargets {
	return new Map(entries.map((entry) => [parseVolume(entry).target, entry]));
}

/**
 * Why `grant` would make the service invalid next to `mounted`, or undefined
 * when it applies cleanly. An entry identical to one already mounted is no
 * conflict — applying it is a no-op. Accepted entries are added to `mounted`.
 */
function grantConflict(
	grant: HostCapabilityGrant,
	mounted: MountedTargets,
): string | undefined {
	const additions: MountedTargets = new Map();
	for (const entry of grant.volumes ?? []) {
		const { source, target } = parseVolume(entry);
		if (source !== undefined && !isHostPath(source)) {
			return `the grant mounts named volume \`${source}\`, which the generated project does not declare — grant a host path`;
		}
		const existing = mounted.has(target)
			? mounted.get(target)
			: additions.get(target);
		if ((mounted.has(target) || additions.has(target)) && existing !== entry) {
			return `the grant mounts a second volume on \`${target}\`, which the service already mounts`;
		}
		additions.set(target, entry);
	}
	for (const [target, entry] of additions) mounted.set(target, entry);
	return undefined;
}

/**
 * Collect every capability entry of `component` — `requires`, each key of
 * the legacy block, `supports` — and put each to the policy. No policy means
 * every required entry is refused and every optional one is left ungranted,
 * which is this provider's own answer.
 *
 * `mountedPaths` are the container paths the generator mounts on the service
 * before grants land. `unsupplied` checks a grant's properties against the
 * entry's `set_env`.
 */
export function resolveHostCapabilities(
	componentName: string,
	component: NormalizedComponent,
	policy: HostCapabilityPolicy | undefined,
	mountedPaths: readonly string[] = [],
	unsupplied: UnsuppliedProperties = () => [],
): HostCapabilityOutcome {
	const outcome: HostCapabilityOutcome = {
		refused: [],
		grants: [],
		properties: new Map(),
		notes: [],
	};

	const pending: PendingRequest[] = [];
	const fromEntries = (
		entries: NormalizedRequirement[] | undefined,
		mode: "requires" | "supports",
	): void => {
		for (const entry of entries ?? []) {
			if (!entry.host) continue;
			pending.push({
				request: { component: componentName, mode, capabilities: entry.host },
				entry,
				labels: Object.entries(entry.host).map(
					([capability, value]) => `${capability}=${String(value)}`,
				),
			});
		}
	};
	fromEntries(component.requires, "requires");
	const legacy = legacyBlockRequests(componentName, component);
	pending.push(...legacy.filter((p) => p.request.mode === "requires"));
	fromEntries(component.supports, "supports");
	pending.push(...legacy.filter((p) => p.request.mode === "supports"));

	// Grants accepted so far stack on the service: each later grant is checked
	// against the generator's mounts plus every earlier grant's.
	const mounted: MountedTargets = new Map(
		mountedPaths.map((path) => [normalizeTarget(path), undefined]),
	);

	for (const { request, entry, labels } of pending) {
		const decision = policy?.(request);
		let reason: string | undefined;
		if (decision && "granted" in decision) {
			const grant = decision.granted;
			const properties = grant.properties ?? {};
			const missing = entry ? unsupplied(entry, properties) : [];
			const conflict =
				missing.length > 0 ? undefined : grantConflict(grant, mounted);
			if (missing.length > 0) {
				reason =
					`granted without ${missing.map((p) => `\`${p}\``).join(", ")}, ` +
					"which the entry's set_env reads";
			} else if (conflict !== undefined) {
				reason = conflict;
			} else {
				outcome.grants.push(grant);
				if (entry) outcome.properties.set(entry, properties);
				outcome.notes.push(
					`granted: ${componentName}: host capability ${labels.join("; ")}` +
						(grant.summary ? ` (${policyText(grant.summary)})` : ""),
				);
				continue;
			}
		} else if (decision && "refused" in decision) {
			reason = policyText(decision.refused);
		}

		if (request.mode === "requires") {
			const listed = labels.join("; ");
			outcome.refused.push(reason ? `${listed}: ${reason}` : listed);
			continue;
		}
		for (const label of labels) {
			outcome.notes.push(
				`${componentName}: optional host capability ${label} ` +
					(reason ? `not granted (${reason}) ` : "not granted ") +
					"— its set_env vars are omitted and the app runs degraded",
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

/**
 * Merge every grant into the assembled compose service, union for lists. A
 * grant that would make the service invalid (a named volume, or a second
 * mount on a container path already mounted) is not applied; its reason is
 * returned so the caller can refuse it. A
 * `network_mode` grant removes the service's `networks:`, which compose
 * rejects alongside it.
 */
export function applyHostCapabilityGrants(
	service: Record<string, unknown>,
	grants: HostCapabilityGrant[],
): string[] {
	const rejected: string[] = [];
	for (const grant of grants) {
		const mounted = mountedTargets(
			Array.isArray(service.volumes) ? (service.volumes as string[]) : [],
		);
		const conflict = grantConflict(grant, mounted);
		if (conflict !== undefined) {
			rejected.push(conflict);
			continue;
		}
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
		if (grant.network_mode !== undefined) delete service.networks;
	}
	return rejected;
}
