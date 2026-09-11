/**
 * Deterministic port allocation for Launchfile apps.
 *
 * Ports are derived from a hash of the app name so they're stable across runs
 * and machines. If a port is in use, we scan upward for the next free one.
 */

import { createServer } from "node:net";

/** Base range for allocated ports */
const PORT_RANGE_START = 10_000;
const PORT_RANGE_SIZE = 10_000;

/** Simple string hash → number in a range */
function hashToRange(input: string, rangeSize: number): number {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = (hash * 31 + input.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % rangeSize;
}

/** Check if a port is available by attempting to listen on it */
async function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => {
			server.close(() => resolve(true));
		});
		server.listen(port, "127.0.0.1");
	});
}

/**
 * Allocate a port for a given key (e.g., "myapp" or "myapp:backend").
 * Uses deterministic hashing for stability, with fallback scan.
 */
export async function allocatePort(
	key: string,
	existingPorts: Set<number>,
): Promise<number> {
	const preferred = PORT_RANGE_START + hashToRange(key, PORT_RANGE_SIZE);

	// Try the preferred port first
	if (!existingPorts.has(preferred) && (await isPortFree(preferred))) {
		return preferred;
	}

	// Scan upward for the next free port
	for (let offset = 1; offset < PORT_RANGE_SIZE; offset++) {
		const candidate = PORT_RANGE_START + ((preferred - PORT_RANGE_START + offset) % PORT_RANGE_SIZE);
		if (!existingPorts.has(candidate) && (await isPortFree(candidate))) {
			return candidate;
		}
	}

	throw new Error(`No free port found in range ${PORT_RANGE_START}–${PORT_RANGE_START + PORT_RANGE_SIZE}`);
}

/**
 * Allocate ports for all components in a launch config.
 * Returns a map of component name → port.
 */
export async function allocatePorts(
	components: Record<string, { provides?: Array<{ port: number; exposed?: boolean }> }>,
	appName: string,
	savedPorts?: Record<string, number>,
): Promise<Record<string, number>> {
	const allocated = new Set<number>();
	const result: Record<string, number> = {};

	for (const [name, component] of Object.entries(components)) {
		// Reuse saved port if still free
		const saved = savedPorts?.[name];
		if (saved && (await isPortFree(saved))) {
			result[name] = saved;
			allocated.add(saved);
			continue;
		}

		// Use the component's declared port if free.
		//
		// D-27: only an `exposed: true` endpoint is reachable from outside the
		// host, so it anchors the single port this provider allocates. Fully
		// internal components keep provides[0]. The docker provider answers
		// $app.* by this same rule (app-url.ts), and this line is what makes the
		// two agree on a file whose first entry is not the exposed one.
		//
		// Residual: this provider runs one host process per component and
		// allocates it one port, so a component declaring several endpoints
		// collapses to the anchor — every non-anchor endpoint is unallocated
		// here. The allocated port also need not equal any declared port: when
		// the preferred one is taken, the fall-through below picks a
		// deterministic free port instead. See #276 for what that costs
		// `$components.<name>.<endpoint>.*` on this provider.
		const declaredPort = (
			component.provides?.find((p) => p.exposed === true) ?? component.provides?.[0]
		)?.port;
		if (declaredPort && !allocated.has(declaredPort) && (await isPortFree(declaredPort))) {
			result[name] = declaredPort;
			allocated.add(declaredPort);
			continue;
		}

		// Fall back to deterministic allocation
		const port = await allocatePort(`${appName}:${name}`, allocated);
		result[name] = port;
		allocated.add(port);
	}

	return result;
}
