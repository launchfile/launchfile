import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveUpTarget } from "../resolve-target.js";

const CATALOG_DIR = join(import.meta.dirname, "../../../../catalog");

describe("resolveUpTarget", () => {
	it("resolves a catalog slug", () => {
		const result = resolveUpTarget("ghost");
		expect(result.type).toBe("catalog");
		expect(result.value).toBe("ghost");
	});

	it("resolves a local path", () => {
		const launchfile = join(CATALOG_DIR, "apps/ghost/Launchfile");
		const result = resolveUpTarget(launchfile);
		expect(result.type).toBe("local");
		expect(result.value).toBe(launchfile);
	});

	it("resolves a URL", () => {
		const url = "https://launchfile.io/apps/ghost/Launchfile";
		const result = resolveUpTarget(url);
		expect(result.type).toBe("url");
		expect(result.value).toBe(url);
	});

	it("treats multi-word slugs as catalog", () => {
		const result = resolveUpTarget("audiobookshelf");
		expect(result.type).toBe("catalog");
		expect(result.value).toBe("audiobookshelf");
	});
});
