/**
 * Port allocation for the Docker provider.
 *
 * Prefers the app's declared port (e.g., Ghost → 2368), falls back
 * to deterministic hashing if that port is occupied.
 */

import { createSocket } from "node:dgram";
import { createServer } from "node:net";

const PORT_RANGE_START = 10_000;
const PORT_RANGE_SIZE = 10_000;

/**
 * The wire protocol a host port is claimed on. Application protocols
 * (http, https, ws, grpc) all ride TCP; only `udp` occupies the UDP side,
 * so a tcp and a udp endpoint can share one host port number.
 */
type WireProtocol = "tcp" | "udp";

function wireProtocol(protocol?: string): WireProtocol {
	return protocol === "udp" ? "udp" : "tcp";
}

/** A `taken`-set entry: one host port on one wire protocol. */
function portSlot(port: number, proto: WireProtocol): string {
	return `${port}/${proto}`;
}

function hashToRange(input: string, rangeSize: number): number {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = (hash * 31 + input.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % rangeSize;
}

async function isPortFree(port: number, proto: WireProtocol): Promise<boolean> {
	if (proto === "udp") {
		return new Promise((resolve) => {
			const socket = createSocket("udp4");
			socket.once("error", () => resolve(false));
			socket.bind(port, "127.0.0.1", () => {
				socket.close(() => resolve(true));
			});
		});
	}
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => {
			server.close(() => resolve(true));
		});
		server.listen(port, "127.0.0.1");
	});
}

async function allocatePort(key: string, taken: Set<string>, proto: WireProtocol): Promise<number> {
	const preferred = PORT_RANGE_START + hashToRange(key, PORT_RANGE_SIZE);

	if (!taken.has(portSlot(preferred, proto)) && (await isPortFree(preferred, proto))) {
		return preferred;
	}

	for (let offset = 1; offset < PORT_RANGE_SIZE; offset++) {
		const candidate = PORT_RANGE_START + ((preferred - PORT_RANGE_START + offset) % PORT_RANGE_SIZE);
		if (!taken.has(portSlot(candidate, proto)) && (await isPortFree(candidate, proto))) {
			return candidate;
		}
	}

	throw new Error(`No free port found in range ${PORT_RANGE_START}–${PORT_RANGE_START + PORT_RANGE_SIZE}`);
}

/** The provides-entry shape the allocator needs. Structural subset of the SDK's normalized form. */
export interface ProvidesEntry {
	port: number;
	exposed?: boolean;
	name?: string;
	protocol?: string;
	bind?: string;
}

/** One host-publishable endpoint, with the state key it is allocated and persisted under. */
export interface PublishedEndpoint {
	/** State/allocation key: bare component name for the primary, `component:name` (or `component:port`) for the rest */
	key: string;
	component: string;
	/** Endpoint `name` from the provides entry, when declared (D-6) */
	name?: string;
	/** Container port */
	port: number;
	protocol?: string;
	bind?: string;
}

/**
 * The endpoints of a component that are entitled to a host mapping.
 *
 * Publication requires an explicit `exposed: true` (D-27 — endpoints are
 * internal by default; SPEC.md documents `exposed` defaulting to `false`).
 * Entries that omit `exposed` stay reachable in-network but are never
 * published to the host.
 *
 * Key scheme: the first published endpoint keeps the bare component name as
 * its key, because saved state, `$app.url`, and the launch summary all read
 * it that way. Every additional endpoint is keyed `component:name` when the
 * entry declares a `name` (D-6 — the endpoint's designated identity), falling
 * back to `component:port`, with an index suffix if two entries would
 * otherwise collide (e.g. two unnamed entries on the same container port).
 * The generator and the allocator both derive keys from this function, so
 * their maps always line up.
 */
export function publishedEndpoints(
	componentName: string,
	provides: ProvidesEntry[] | undefined,
): PublishedEndpoint[] {
	const published = provides?.filter((p) => p.exposed === true) ?? [];
	const used = new Set<string>();
	return published.map((p, index) => {
		let key = index === 0 ? componentName : `${componentName}:${p.name ?? p.port}`;
		if (used.has(key)) key = `${key}:${index}`;
		used.add(key);
		return {
			key,
			component: componentName,
			name: p.name,
			port: p.port,
			protocol: p.protocol,
			bind: p.bind,
		};
	});
}

/**
 * Allocate host ports for every endpoint marked `exposed: true`.
 *
 * Returns a map keyed per `publishedEndpoints`: bare component name for each
 * component's first published endpoint, `component:name` / `component:port`
 * for every additional one. Saved ports are reused when still free, so a
 * restart keeps its URLs; the fallback allocation is seeded per key, so two
 * endpoints on one component cannot land on the same candidate.
 *
 * Availability is tracked per (port, wire protocol): a `udp` endpoint claims
 * only the UDP side of a port and is probed with a UDP socket, so a tcp/udp
 * pair on one container port (the DNS shape) shares its host port and
 * round-trips saved state identically.
 */
export async function allocatePorts(
	components: Record<string, { provides?: ProvidesEntry[] }>,
	appName: string,
	savedPorts?: Record<string, number>,
): Promise<Record<string, number>> {
	const taken = new Set<string>();
	const result: Record<string, number> = {};

	for (const [name, component] of Object.entries(components)) {
		for (const endpoint of publishedEndpoints(name, component.provides)) {
			const { key, port: containerPort } = endpoint;
			const proto = wireProtocol(endpoint.protocol);

			// Reuse saved port if still free, so a restart keeps its URLs.
			const saved = savedPorts?.[key];
			if (saved && !taken.has(portSlot(saved, proto)) && (await isPortFree(saved, proto))) {
				result[key] = saved;
				taken.add(portSlot(saved, proto));
				continue;
			}

			// Prefer the container's declared port as the host port.
			if (!taken.has(portSlot(containerPort, proto)) && (await isPortFree(containerPort, proto))) {
				result[key] = containerPort;
				taken.add(portSlot(containerPort, proto));
				continue;
			}

			// Fall back to deterministic allocation. The primary's seed is
			// `app:component` (unchanged across releases, so existing
			// deployments keep their ports); secondaries hash their own key.
			const port = await allocatePort(`${appName}:${key}`, taken, proto);
			result[key] = port;
			taken.add(portSlot(port, proto));
		}
	}

	return result;
}
