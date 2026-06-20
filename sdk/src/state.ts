/**
 * Pure-core deployment state, event, and reference-resolution model.
 *
 * A provider runs a deployment as a stream of {@link LaunchEvent}s. This module
 * gives the SDK a deterministic, side-effect-free way to fold those events into
 * a {@link DeploymentState} ({@link reduce}), to recover the events that
 * separate two states ({@link diff}), and to resolve `$`-references against a
 * state from a particular consumer's {@link Vantage} ({@link resolveRef}).
 *
 * Everything here is pure: no fs, no logging, no clocks, no mutation of inputs.
 * The SDK never performs I/O — it throws or returns. Callers own timestamps,
 * persistence, and emission. See the note on {@link reduce} about `updatedAt`.
 */

/**
 * Where a reference is being resolved *from*. Determines whether a consumer
 * reaches an endpoint via its published (host-side) or internal (in-network)
 * address.
 *
 * - `provider` — the provider resolving the reference (e.g. "docker").
 * - `mode` — `source` runs on the host (gets published addresses); `artifact`
 *   runs inside the provider's network (gets internal addresses).
 * - `network` — explicit network hint. `host` forces published; `compose`
 *   forces internal. Open string for provider-specific networks.
 */
export type Vantage = {
	provider: string;
	mode: "source" | "artifact";
	network?: "host" | "compose" | (string & {});
};

/** A resolved network endpoint exposed by a component or resource. */
export interface Endpoint {
	/** Endpoint name (e.g. "http", "metrics"); the default endpoint is "default". */
	name: string;
	/** URL scheme / protocol (e.g. "http", "postgres", "tcp"). */
	scheme: string;
	/** In-network address (`host:port`), reachable by same-network consumers. */
	internal: string;
	/** Host-side address (`host:port`), reachable from outside the network. */
	published?: string;
}

/**
 * An event in a deployment's lifecycle. Two disjoint families:
 *
 * - **slot events** — lifecycle progress for a component's `prepare`/`release`/
 *   `run` slot (started → completed/failed).
 * - **kind events** — discrete facts (endpoint resolved, status change, a
 *   captured value, a provisioned resource).
 */
export type LaunchEvent =
	| {
			slot: "prepare" | "release" | "run";
			phase: "started" | "completed" | "failed";
			component: string;
	  }
	| { kind: "endpoint.resolved"; component: string; endpoint: Endpoint }
	| {
			kind: "component.status";
			component: string;
			status: "up" | "down" | "unhealthy";
	  }
	| {
			kind: "capture";
			component: string;
			name: string;
			value: string;
			sensitive?: boolean;
	  }
	| {
			kind: "resource.provisioned";
			name: string;
			type: string;
			endpoints: Endpoint[];
	  };

/** Per-component slice of deployment state. */
export interface ComponentState {
	/** Whether this component runs from source or a built artifact. */
	mode: "source" | "artifact";
	/** Free-form status string (e.g. "up", "down", "running", "prepare:started"). */
	status: string;
	/** Resolved endpoints, in stable name order. */
	endpoints: Endpoint[];
	/** Environment the component runs with. */
	env: Record<string, string>;
	/** Captured values keyed by capture name. */
	captures: Record<string, string>;
	/** Process id, when the provider runs the component as a host process. */
	pid?: number;
}

/** Per-resource slice of deployment state (postgres, redis, …). */
export interface ResourceState {
	/** Resource type (e.g. "postgres"). */
	type: string;
	/** Free-form status string. */
	status: string;
	/** Resolved endpoints, in stable name order. */
	endpoints: Endpoint[];
	/** Environment the resource exposes. */
	env: Record<string, string>;
}

/** The full deployment state — the fold target for {@link reduce}. */
export interface DeploymentState {
	/** Deployment id (provider-assigned slug). */
	id: string;
	/** App name. */
	app: string;
	/**
	 * Caller-owned last-update timestamp (ISO 8601). {@link reduce} never sets
	 * this from a clock; see the note on {@link reduce}.
	 */
	updatedAt: string;
	/** Components keyed by name. */
	components: Record<string, ComponentState>;
	/** Resources keyed by name. */
	resources: Record<string, ResourceState>;
}

// --- reduce ---

/** Status string a slot/phase event records on its component. */
function slotStatus(
	slot: "prepare" | "release" | "run",
	phase: "started" | "completed" | "failed",
): string {
	// "run" maps onto the lifecycle words operators expect; prepare/release keep
	// their slot name so a status string is self-describing in either family.
	if (slot === "run") {
		if (phase === "completed") return "up";
		if (phase === "failed") return "down";
		return "starting";
	}
	return `${slot}:${phase}`;
}

/** Create an empty component slice. */
function emptyComponent(mode: "source" | "artifact"): ComponentState {
	return { mode, status: "pending", endpoints: [], env: {}, captures: {} };
}

/** Insert/replace an endpoint by name, returning a new, name-sorted array. */
function upsertEndpoint(endpoints: Endpoint[], next: Endpoint): Endpoint[] {
	const others = endpoints.filter((e) => e.name !== next.name);
	return [...others, next].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pure fold: apply one {@link LaunchEvent} to a {@link DeploymentState},
 * returning a NEW state. The input is never mutated (copy-on-write at every
 * level the event touches).
 *
 * `updatedAt` is intentionally NOT derived from a clock here — `reduce` must be
 * deterministic and pure. If the caller wants the result stamped, it passes a
 * timestamp via the optional `at` argument; otherwise `updatedAt` is carried
 * over from the input unchanged and the caller can stamp the result itself.
 */
export function reduce(
	state: DeploymentState,
	event: LaunchEvent,
	at?: string,
): DeploymentState {
	const updatedAt = at ?? state.updatedAt;

	if ("slot" in event) {
		const prev =
			state.components[event.component] ?? emptyComponent("artifact");
		const components = {
			...state.components,
			[event.component]: {
				...prev,
				status: slotStatus(event.slot, event.phase),
			},
		};
		return { ...state, updatedAt, components };
	}

	switch (event.kind) {
		case "endpoint.resolved": {
			const prev =
				state.components[event.component] ?? emptyComponent("artifact");
			const components = {
				...state.components,
				[event.component]: {
					...prev,
					endpoints: upsertEndpoint(prev.endpoints, event.endpoint),
				},
			};
			return { ...state, updatedAt, components };
		}
		case "component.status": {
			const prev =
				state.components[event.component] ?? emptyComponent("artifact");
			const components = {
				...state.components,
				[event.component]: { ...prev, status: event.status },
			};
			return { ...state, updatedAt, components };
		}
		case "capture": {
			const prev =
				state.components[event.component] ?? emptyComponent("artifact");
			const components = {
				...state.components,
				[event.component]: {
					...prev,
					captures: { ...prev.captures, [event.name]: event.value },
				},
			};
			return { ...state, updatedAt, components };
		}
		case "resource.provisioned": {
			const prev = state.resources[event.name];
			const endpoints = [...event.endpoints].sort((a, b) =>
				a.name.localeCompare(b.name),
			);
			const resources = {
				...state.resources,
				[event.name]: {
					type: event.type,
					status: prev?.status ?? "up",
					endpoints,
					env: prev?.env ?? {},
				},
			};
			return { ...state, updatedAt, resources };
		}
	}
}

// --- diff ---

/** Stable JSON identity for an endpoint, for set-difference comparisons. */
function endpointKey(e: Endpoint): string {
	return JSON.stringify([e.name, e.scheme, e.internal, e.published ?? ""]);
}

/**
 * Compute a minimal, deterministic list of events that, folded over `prev` in
 * order, yields `next` for the fields the event types cover (component status,
 * endpoints, captures, and resources). Ordering is stable: components and
 * resources are visited in sorted name order, endpoints/captures within each in
 * sorted name order.
 *
 * Fields with no covering event (e.g. `mode`, `pid`, `env`) are not diffed.
 */
export function diff(
	prev: DeploymentState,
	next: DeploymentState,
): LaunchEvent[] {
	const events: LaunchEvent[] = [];

	for (const component of Object.keys(next.components).sort()) {
		const before = prev.components[component];
		const after = next.components[component]!;

		// Endpoints: emit one endpoint.resolved per added-or-changed endpoint.
		const beforeEndpoints = new Map(
			(before?.endpoints ?? []).map((e) => [e.name, endpointKey(e)]),
		);
		for (const endpoint of [...after.endpoints].sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (beforeEndpoints.get(endpoint.name) !== endpointKey(endpoint)) {
				events.push({ kind: "endpoint.resolved", component, endpoint });
			}
		}

		// Status: emit component.status when it changed to a known status value.
		if (before?.status !== after.status && isKnownStatus(after.status)) {
			events.push({
				kind: "component.status",
				component,
				status: after.status,
			});
		}

		// Captures: emit capture for each added-or-changed value.
		for (const name of Object.keys(after.captures).sort()) {
			if (before?.captures[name] !== after.captures[name]) {
				events.push({
					kind: "capture",
					component,
					name,
					value: after.captures[name]!,
				});
			}
		}
	}

	for (const name of Object.keys(next.resources).sort()) {
		const before = prev.resources[name];
		const after = next.resources[name]!;
		const beforeEndpoints = (before?.endpoints ?? [])
			.map(endpointKey)
			.join("|");
		const afterEndpoints = after.endpoints.map(endpointKey).join("|");
		if (before?.type !== after.type || beforeEndpoints !== afterEndpoints) {
			events.push({
				kind: "resource.provisioned",
				name,
				type: after.type,
				endpoints: after.endpoints,
			});
		}
	}

	return events;
}

/** Whether a status string is one a `component.status` event can carry. */
function isKnownStatus(status: string): status is "up" | "down" | "unhealthy" {
	return status === "up" || status === "down" || status === "unhealthy";
}

// --- resolveRef ---

/**
 * URL/host/port-style property names whose value depends on the consumer's
 * vantage (published vs internal address). Other props (e.g. captures, env) are
 * vantage-independent.
 */
const ADDRESS_PROPS = new Set(["url", "host", "port", "authority", "address"]);

/** Whether this vantage reaches endpoints by their published (host-side) address. */
function prefersPublished(vantage: Vantage): boolean {
	if (vantage.network === "host") return true;
	if (vantage.network === "compose") return false;
	// No explicit network hint: source-mode consumers run on the host.
	return vantage.mode === "source";
}

/** Pick the address an endpoint exposes for a given vantage, with fallback. */
function addressFor(endpoint: Endpoint, vantage: Vantage): string {
	if (prefersPublished(vantage)) return endpoint.published ?? endpoint.internal;
	return endpoint.internal;
}

/** Derive a single address-shaped property from an endpoint. */
function endpointProp(
	endpoint: Endpoint,
	prop: string,
	vantage: Vantage,
): string {
	const address = addressFor(endpoint, vantage);
	switch (prop) {
		case "host":
			return address.split(":")[0] ?? "";
		case "port":
			return address.includes(":") ? (address.split(":")[1] ?? "") : "";
		case "authority":
		case "address":
			return address;
		default:
			// "url"
			return address ? `${endpoint.scheme}://${address}` : "";
	}
}

/**
 * Resolve a `$`-reference against a {@link DeploymentState} from a consumer's
 * {@link Vantage}.
 *
 * Supported forms:
 * - `$components.<name>.<prop>` — a component's endpoint/capture property.
 * - `$<resource>.<prop>` — a resource's endpoint property.
 *
 * Address-shaped props (`url`, `host`, `port`, `authority`, `address`) resolve
 * against the default endpoint and honor the vantage: a host / source-mode
 * consumer gets the published address (falling back to internal when no
 * published address exists); an in-network consumer gets the internal address.
 * A `<prop>` matching a capture name resolves to that capture's value.
 *
 * Unknown references return "" — mirroring the `$`-expression resolver, which
 * never throws on an unresolved reference (the caller supplies `:-default` or
 * falls back to the empty string).
 */
export function resolveRef(
	state: DeploymentState,
	ref: string,
	vantage: Vantage,
): string {
	if (!ref.startsWith("$")) return "";
	const path = ref.slice(1).split(".");

	if (path[0] === "components") {
		const name = path[1];
		const prop = path[2];
		if (!name || !prop) return "";
		const component = state.components[name];
		if (!component) return "";
		if (prop in component.captures) return component.captures[prop]!;
		const endpoint = defaultEndpoint(component.endpoints);
		if (!endpoint || !ADDRESS_PROPS.has(prop)) return "";
		return endpointProp(endpoint, prop, vantage);
	}

	// $<resource>.<prop>
	const name = path[0];
	const prop = path[1];
	if (!name || !prop) return "";
	const resource = state.resources[name];
	if (!resource) return "";
	const endpoint = defaultEndpoint(resource.endpoints);
	if (!endpoint || !ADDRESS_PROPS.has(prop)) return "";
	return endpointProp(endpoint, prop, vantage);
}

/** The endpoint named "default" if present, else the first by sort order. */
function defaultEndpoint(endpoints: Endpoint[]): Endpoint | undefined {
	if (endpoints.length === 0) return undefined;
	return endpoints.find((e) => e.name === "default") ?? endpoints[0];
}
