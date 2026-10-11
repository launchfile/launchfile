import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	PUBLISHED_SCHEMA_PATH,
	collectExtensionKeywords,
	compilePublishedSchema,
	validateCatalog,
	collectImageLines,
	lintImageReferences,
	metadataImageNames,
	parseImageRef,
} from "./validate-catalog.ts";

function lint(text: string, opts: { changed?: boolean; metadataText?: string } = {}) {
	return lintImageReferences({
		file: "catalog/apps/example/Launchfile",
		text,
		app: "example",
		metadataText: opts.metadataText,
		changed: opts.changed ?? true,
	});
}

describe("parseImageRef", () => {
	it("reads the tag after the last slash", () => {
		expect(parseImageRef("ghost:5-alpine")).toEqual({
			kind: "tagged",
			name: "ghost",
			tag: "5-alpine",
		});
	});

	it("treats a registry port as part of the name, not a tag", () => {
		expect(parseImageRef("registry.example:5000/app")).toEqual({
			kind: "bare",
			name: "registry.example:5000/app",
		});
	});

	it("reads a tag on an image behind a ported registry", () => {
		expect(parseImageRef("registry.example:5000/app:1.2")).toEqual({
			kind: "tagged",
			name: "registry.example:5000/app",
			tag: "1.2",
		});
	});

	it("recognizes a digest reference", () => {
		expect(parseImageRef("ghost@sha256:abc123").kind).toBe("digest");
	});
});

describe("collectImageLines", () => {
	it("finds component images as well as the top-level one", () => {
		const lines = collectImageLines(
			["image: app:1", "components:", "  web:", "    image: web:2"].join("\n"),
		);
		expect(lines.map((l) => l.ref)).toEqual(["app:1", "web:2"]);
		expect(lines.map((l) => l.line)).toEqual([1, 4]);
	});

	it("splits the trailing rationale comment off the reference", () => {
		const [line] = collectImageLines("image: app:latest  # upstream publishes no versioned tag");
		expect(line?.ref).toBe("app:latest");
		expect(line?.rationale).toBe("upstream publishes no versioned tag");
	});

	it("keeps a `#` inside a quoted reference", () => {
		const [line] = collectImageLines('image: "app:1#odd"');
		expect(line?.ref).toBe("app:1#odd");
		expect(line?.rationale).toBeUndefined();
	});
});

describe("lintImageReferences — errors", () => {
	it("rejects a bare reference whether or not the file changed", () => {
		for (const changed of [true, false]) {
			const findings = lint("image: example/app", { changed });
			expect(findings).toHaveLength(1);
			expect(findings[0]?.severity).toBe("error");
			expect(findings[0]?.message).toContain("carries no tag");
		}
	});

	it("rejects an @sha256 digest, which catalog policy forbids", () => {
		const findings = lint("image: example/app@sha256:deadbeef", { changed: false });
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe("error");
		expect(findings[0]?.message).toContain("digest");
	});

	it("accepts a tagged reference", () => {
		expect(lint("image: ghost:5-alpine")).toEqual([]);
	});
});

describe("lintImageReferences — :latest warning", () => {
	it("warns on an unannotated :latest in a changed file", () => {
		const findings = lint("image: example/app:latest");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe("warning");
		expect(findings[0]?.line).toBe(1);
	});

	it("stays silent when the file is not part of the change", () => {
		expect(lint("image: example/app:latest", { changed: false })).toEqual([]);
	});

	it("stays silent when the line states why", () => {
		expect(lint("image: example/app:latest  # upstream publishes no versioned tag")).toEqual([]);
	});
});

describe("lintImageReferences — metadata drift warning", () => {
	const metadata = ["images:", "  - name: example/app:1.0", "    size_mb: 10"].join("\n");

	it("warns when metadata records another tag of the same repository", () => {
		const findings = lint("image: example/app:2.0", { metadataText: metadata });
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe("warning");
		expect(findings[0]?.message).toContain("measurements are stale");
		expect(findings[0]?.message).toContain("bun run src/test-app.ts example");
	});

	it("stays silent when the tags agree", () => {
		expect(lint("image: example/app:1.0", { metadataText: metadata })).toEqual([]);
	});

	it("stays silent for a repository metadata never measured", () => {
		expect(lint("image: other/app:1.0", { metadataText: metadata })).toEqual([]);
	});

	it("stays silent when the file is not part of the change", () => {
		expect(lint("image: example/app:2.0", { metadataText: metadata, changed: false })).toEqual(
			[],
		);
	});
});

describe("metadataImageNames", () => {
	it("returns an empty list for metadata with no images block", () => {
		expect(metadataImageNames("category: CMS\n")).toEqual([]);
	});
});

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

function publishedSchema(): object {
	return JSON.parse(readFileSync(join(REPO_ROOT, PUBLISHED_SCHEMA_PATH), "utf8")) as object;
}

describe("compilePublishedSchema", () => {
	const check = compilePublishedSchema(publishedSchema());

	it("accepts a minimal Launchfile", () => {
		expect(check({ name: "x" })).toEqual({ valid: true });
	});

	it("rejects a field the schema does not declare and names the schema location", () => {
		const result = check({ name: "x", storage: { data: { path: "/d", description: "no" } } });
		expect(result.valid).toBe(false);
		if (result.valid) return;
		expect(result.errors.join(" ")).toContain("/storage/data");
		expect(result.errors.join(" ")).toContain("#/$defs/storageVolume/additionalProperties");
	});
});

describe("collectExtensionKeywords", () => {
	it("finds nested x- keys", () => {
		expect([...collectExtensionKeywords({ a: [{ "x-one": 1 }], b: { "x-two": 2 } })].sort()).toEqual([
			"x-one",
			"x-two",
		]);
	});
});

describe("validateCatalog — published schema", () => {
	function fixtureRoot(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "catalog-"));
		const schemaPath = join(root, PUBLISHED_SCHEMA_PATH);
		mkdirSync(dirname(schemaPath), { recursive: true });
		writeFileSync(schemaPath, JSON.stringify(publishedSchema()));
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), text);
		}
		return root;
	}

	it("passes a conforming entry", () => {
		const root = fixtureRoot({
			"catalog/apps/ok/Launchfile": "name: ok\n",
		});
		const report = validateCatalog(root, new Set());
		expect(report.files).toBe(1);
		expect(report.findings.filter((f) => f.message.includes("published JSON Schema"))).toEqual([]);
	});

	it("fails naming the file and the published schema when the schema rejects it", () => {
		const root = fixtureRoot({
			"catalog/apps/bad/Launchfile":
				"name: bad\nstorage:\n  d:\n    path: /d\n    description: undeclared\n",
		});
		const finding = validateCatalog(root, new Set()).findings.find((f) =>
			f.message.includes("published JSON Schema"),
		);
		expect(finding?.severity).toBe("error");
		expect(finding?.file).toBe("catalog/apps/bad/Launchfile");
		expect(finding?.message).toContain(PUBLISHED_SCHEMA_PATH);
	});

	it("fails on an empty catalog", () => {
		const report = validateCatalog(fixtureRoot({}), new Set());
		expect(report.findings.some((f) => f.severity === "error" && f.file === "catalog")).toBe(true);
	});

	it("fails when an entry directory has no Launchfile", () => {
		const root = fixtureRoot({
			"catalog/apps/ok/Launchfile": "name: ok\n",
			"catalog/drafts/empty/metadata.yaml": "images: []\n",
		});
		const report = validateCatalog(root, new Set());
		expect(report.findings.some((f) => f.severity === "error" && f.file === "catalog")).toBe(true);
	});
});
