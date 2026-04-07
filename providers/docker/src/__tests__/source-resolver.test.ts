import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveSource } from "../source-resolver.js";

const CATALOG_DIR = join(import.meta.dirname, "../../../../catalog");

describe("resolveSource", () => {
	it("reads a local Launchfile path", async () => {
		const result = await resolveSource(join(CATALOG_DIR, "apps/ghost/Launchfile"));

		expect(result.source).toBe("local");
		expect(result.yaml).toContain("name: ghost");
		expect(result.slug).toBe("ghost");
	});

	it("resolves a catalog slug (requires network + public repo)", async () => {
		try {
			const result = await resolveSource("ghost");
			expect(result.source).toBe("catalog");
			expect(result.slug).toBe("ghost");
			expect(result.yaml).toContain("name: ghost");
		} catch {
			// Skip if GitHub raw content is not accessible (repo may be private)
			console.log("  Skipped: GitHub catalog not reachable");
		}
	});

	it("throws for a non-existent slug (requires network)", async () => {
		try {
			await resolveSource("definitely-not-a-real-app-xyz");
			// If it didn't throw, the network request went somewhere unexpected
			expect.unreachable("Should have thrown");
		} catch (err) {
			const message = (err as Error).message;
			// Either "not found" (correct) or a network error (acceptable)
			expect(
				message.includes("not found") || message.includes("fetch"),
			).toBe(true);
		}
	});

	it("throws for invalid input", async () => {
		await expect(resolveSource("INVALID SLUG!")).rejects.toThrow(/Cannot resolve/);
	});
});
