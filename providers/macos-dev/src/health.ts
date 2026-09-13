/**
 * Health check polling for components.
 */

import { parseDurationMs, type NormalizedHealth } from "@launchfile/sdk";
import { redactSecrets } from "./redact.js";
import { shellScript } from "./shell.js";

/**
 * Parse a health duration against the ratified grammar (D-48). Throws on an
 * unparseable value — PROVIDERS.md §10.10 forbids silently substituting a
 * default, and the previous local parser did exactly that in the worst
 * possible way: it accepted no `h` unit and returned 0, so a spec-valid
 * `interval: "1h"` became a zero-length poll that could never pass.
 */
export function parseDuration(duration: string): number {
	return parseDurationMs(duration);
}

/**
 * Whether a check can run without a port: only a `command` check can. A
 * `path` check and the no-check fallback both poll `http://localhost:<port>`.
 */
export function healthCheckNeedsPort(health: NormalizedHealth): boolean {
	return !health.command;
}

/**
 * What a check polls, for the failure message: the operator reading
 * "did not become healthy" needs to know which probe was asked.
 */
export function describeHealthCheck(health: NormalizedHealth, port: number | undefined): string {
	if (health.command) return `command \`${redactSecrets(health.command)}\``;
	const host = port === undefined ? "localhost:<unallocated>" : `localhost:${port}`;
	return `GET http://${host}${health.path ?? "/"}`;
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
				await shellScript(health.command, { timeout: checkTimeout, silent: true });
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
