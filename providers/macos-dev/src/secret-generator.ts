/**
 * Secret and value generators for Launchfile env vars.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { Generator } from "@launchfile/sdk";
import { allocatePort } from "./port-allocator.js";

/**
 * Generate a value based on the generator type.
 */
export async function generateValue(
	generator: Generator,
	existingPorts?: Set<number>,
): Promise<string> {
	switch (generator) {
		case "secret":
			return randomBytes(32).toString("base64url");
		case "uuid":
			return randomUUID();
		case "port": {
			const port = await allocatePort(`generated-${Date.now()}`, existingPorts ?? new Set());
			return String(port);
		}
	}
}

/** Generate a password suitable for database users */
export function generatePassword(): string {
	// URL-safe so it can go in connection strings without encoding
	return randomBytes(24).toString("base64url");
}
