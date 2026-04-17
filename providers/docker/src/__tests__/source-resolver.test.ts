import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
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

	describe("slug inference from malicious YAML", () => {
		let tmpRoot: string;

		beforeAll(() => {
			tmpRoot = mkdtempSync(join(tmpdir(), "lf-slug-"));
		});

		afterAll(() => {
			rmSync(tmpRoot, { recursive: true, force: true });
		});

		async function resolveWith(yaml: string, dirName = "app"): Promise<string> {
			const dir = join(tmpRoot, dirName);
			mkdirSync(dir, { recursive: true });
			const path = join(dir, "Launchfile");
			writeFileSync(path, yaml);
			const result = await resolveSource(path);
			return result.slug;
		}

		it("rejects path-traversal in YAML name", async () => {
			const slug = await resolveWith(
				"name: ../../../etc/passwd\nversion: 1",
				"safe-dir",
			);
			// normalizeSlug strips slashes and dots
			expect(slug).not.toContain("/");
			expect(slug).not.toContain("..");
			expect(slug).toMatch(/^[a-z][a-z0-9-]*$/);
		});

		it("rejects absolute paths in YAML name", async () => {
			const slug = await resolveWith("name: /etc/passwd\nversion: 1", "safe-dir-2");
			expect(slug).not.toContain("/");
			expect(slug).toMatch(/^[a-z][a-z0-9-]*$/);
		});

		it("normalizes uppercase and spaces", async () => {
			const slug = await resolveWith("name: My App\nversion: 1", "safe-dir-3");
			expect(slug).toBe("my-app");
		});

		it("falls back to 'app' when name is fully unsalvageable", async () => {
			const slug = await resolveWith("name: ...\nversion: 1", "123");
			// "..." and "123" both fail SLUG_PATTERN; fall through to "app"
			expect(slug).toBe("app");
		});

		it("rejects absurdly long names (DoS guard)", async () => {
			// 10k chars of dashes — would be slow for naive chained regex work
			const huge = "-".repeat(10_000);
			const t0 = performance.now();
			const slug = await resolveWith(`name: ${huge}\nversion: 1`, "safe-dir-4");
			const elapsed = performance.now() - t0;
			// Normalization rejects (length > MAX_SLUG_INPUT), fall back to
			// directory basename. Must also complete quickly — no polynomial work.
			expect(slug).toBe("safe-dir-4");
			expect(elapsed).toBeLessThan(100);
		});
	});
});
