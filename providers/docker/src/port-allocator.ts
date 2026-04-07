/**
 * Port allocation for the Docker provider.
 *
 * Prefers the app's declared port (e.g., Ghost → 2368), falls back
 * to deterministic hashing if that port is occupied.
 */

import { createServer } from "node:net";

const PORT_RANGE_START = 10_000;
const PORT_RANGE_SIZE = 10_000;

function hashToRange(input: string, rangeSize: number): number {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = (hash * 31 + input.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % rangeSize;
}

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

async function allocatePort(key: string, taken: Set<number>): Promise<number> {
	const preferred = PORT_RANGE_START + hashToRange(key, PORT_RANGE_SIZE);

	if (!taken.has(preferred) && (await isPortFree(preferred))) {
		return preferred;
	}

	for (let offset = 1; offset < PORT_RANGE_SIZE; offset++) {
		const candidate = PORT_RANGE_START + ((preferred - PORT_RANGE_START + offset) % PORT_RANGE_SIZE);
		if (!taken.has(candidate) && (await isPortFree(candidate))) {
			return candidate;
		}
	}

	throw new Error(`No free port found in range ${PORT_RANGE_START}–${PORT_RANGE_START + PORT_RANGE_SIZE}`);
}

/**
 * Allocate host ports for all exposed container ports.
 * Returns a map of "componentName:containerPort" → hostPort.
 */
export async function allocatePorts(
	components: Record<string, { provides?: Array<{ port: number; exposed?: boolean }> }>,
	appName: string,
	savedPorts?: Record<string, number>,
): Promise<Record<string, number>> {
	const taken = new Set<number>();
	const result: Record<string, number> = {};

	for (const [name, component] of Object.entries(components)) {
		const exposed = component.provides?.filter((p) => p.exposed !== false) ?? [];
		if (exposed.length === 0) continue;

		// Use first exposed port as the component's primary port
		const containerPort = exposed[0]!.port;
		const key = `${name}`;

		// Reuse saved port if still free
		const saved = savedPorts?.[key];
		if (saved && (await isPortFree(saved))) {
			result[key] = saved;
			taken.add(saved);
			continue;
		}

		// Prefer the container's declared port as the host port
		if (!taken.has(containerPort) && (await isPortFree(containerPort))) {
			result[key] = containerPort;
			taken.add(containerPort);
			continue;
		}

		// Fall back to deterministic allocation
		const port = await allocatePort(`${appName}:${name}`, taken);
		result[key] = port;
		taken.add(port);
	}

	return result;
}
