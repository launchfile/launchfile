/**
 * Health check polling for components.
 */

import type { NormalizedHealth } from "@launchfile/sdk";
import { shell } from "./shell.js";

/** Parse a duration string like "30s", "1m", "500ms" to milliseconds */
export function parseDuration(duration: string): number {
	const match = /^(\d+)(ms|s|m)$/.exec(duration);
	if (!match) return 0;
	const value = Number.parseInt(match[1]!, 10);
	switch (match[2]) {
		case "ms":
			return value;
		case "s":
			return value * 1000;
		case "m":
			return value * 60_000;
		default:
			return 0;
	}
}

/**
 * Wait for a component to become healthy.
 * Returns true if healthy, false if timed out.
 */
export async function waitForHealthy(
	name: string,
	health: NormalizedHealth,
	port: number,
	overallTimeout: number = 60_000,
): Promise<boolean> {
	const startPeriod = parseDuration(health.start_period ?? "0s");
	const interval = parseDuration(health.interval ?? "3s");
	const checkTimeout = parseDuration(health.timeout ?? "5s");

	// Wait for start period
	if (startPeriod > 0) {
		console.log(`  [${name}] Waiting ${health.start_period} start period...`);
		await sleep(startPeriod);
	}

	const deadline = Date.now() + overallTimeout;

	while (Date.now() < deadline) {
		try {
			if (health.path) {
				const resp = await fetch(`http://localhost:${port}${health.path}`, {
					signal: AbortSignal.timeout(checkTimeout),
				});
				if (resp.ok) {
					console.log(`  [${name}] Healthy`);
					return true;
				}
			} else if (health.command) {
				await shell(health.command, { timeout: checkTimeout, silent: true });
				console.log(`  [${name}] Healthy`);
				return true;
			} else {
				// No specific check — try connecting to the port
				const resp = await fetch(`http://localhost:${port}/`, {
					signal: AbortSignal.timeout(checkTimeout),
				}).catch(() => null);
				if (resp) return true;
			}
		} catch {
			// Expected — service not ready yet
		}
		await sleep(interval);
	}

	console.error(`  [${name}] Health check timed out after ${overallTimeout}ms`);
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
