/**
 * Host ports a compose project's running containers already publish, as
 * `<port>/<tcp|udp>` slots, so the port allocator can recognise a re-up of
 * a live deployment as the holder rather than a collision.
 */

import { shell } from "./shell.js";

/**
 * The `<port>/<tcp|udp>` slots a project's containers publish, parsed from
 * `docker compose ps --format json` output (a JSON array or one object per line).
 */
export function publishedSlots(psOutput: string): Set<string> {
	const slots = new Set<string>();
	const trimmed = psOutput.trim();
	if (!trimmed) return slots;
	let rows: unknown[];
	try {
		const parsed: unknown = JSON.parse(trimmed);
		rows = Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		// Compose emits one JSON object per line.
		rows = [];
		for (const line of trimmed.split("\n")) {
			try {
				rows.push(JSON.parse(line));
			} catch {
				// not a JSON row
			}
		}
	}
	for (const row of rows) {
		const publishers = (row as { Publishers?: unknown } | null)?.Publishers;
		if (!Array.isArray(publishers)) continue;
		for (const pub of publishers) {
			const { PublishedPort, Protocol } = (pub ?? {}) as {
				PublishedPort?: unknown;
				Protocol?: unknown;
			};
			if (typeof PublishedPort === "number" && PublishedPort > 0) {
				slots.add(`${PublishedPort}/${Protocol === "udp" ? "udp" : "tcp"}`);
			}
		}
	}
	return slots;
}

/** Slots published by `project`'s containers; empty when it is not running. */
export async function ownPublishedSlots(project: string): Promise<Set<string>> {
	const ps = await shell("docker", ["compose", "-p", project, "ps", "--format", "json"], {
		allowFailure: true,
		silent: true,
	});
	return ps.exitCode === 0 ? publishedSlots(ps.stdout) : new Set<string>();
}
