import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const catalogRoot = resolve(import.meta.dirname, "..", "..");

function slugs(dir: string): string[] {
	return readdirSync(resolve(catalogRoot, dir), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

describe("catalog slugs", () => {
	it("has no slug in both apps/ and drafts/", () => {
		const apps = new Set(slugs("apps"));
		const duplicates = slugs("drafts").filter((slug) => apps.has(slug));
		expect(
			duplicates,
			`slug(s) present in both catalog/apps/ and catalog/drafts/: ${duplicates.join(", ")}`,
		).toEqual([]);
	});
});
