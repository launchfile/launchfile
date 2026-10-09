import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  KNOWN_METADATA_KEYS,
  lintUnknownMetadataKeys,
  rewriteMetadata,
} from "./lint-metadata.ts";

const KNOWN = KNOWN_METADATA_KEYS.join(", ");

describe("lintUnknownMetadataKeys", () => {
  it("names an unknown key, the known set, and that the key is ignored", () => {
    const raw = parse(`
tagline: A thing
knwon_issues:
  - "does not deploy"
`);
    expect(lintUnknownMetadataKeys(raw, "catalog/apps/x/metadata.yaml")).toEqual([
      `catalog/apps/x/metadata.yaml: unrecognized top-level key "knwon_issues" ` +
        `(known: ${KNOWN}) — unknown keys are ignored by the catalog and its test harness`,
    ]);
  });

  it("emits one warning per unknown key", () => {
    const warnings = lintUnknownMetadataKeys({ foo: 1, tagline: "t", bar: 2 });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"foo"');
    expect(warnings[1]).toContain('"bar"');
  });

  it("is silent when every key is known", () => {
    const raw = Object.fromEntries(KNOWN_METADATA_KEYS.map((k) => [k, null]));
    expect(lintUnknownMetadataKeys(raw)).toEqual([]);
  });

  it("does not look inside test_results or images", () => {
    const raw = parse(`
test_results:
  anything_goes: true
images:
  - name: app:1
    whatever: 1
`);
    expect(lintUnknownMetadataKeys(raw)).toEqual([]);
  });

  it("returns no warnings for an empty file or a non-mapping document", () => {
    expect(lintUnknownMetadataKeys(parse(""))).toEqual([]);
    expect(lintUnknownMetadataKeys("just a string")).toEqual([]);
    expect(lintUnknownMetadataKeys(["a", "b"])).toEqual([]);
    expect(lintUnknownMetadataKeys(null)).toEqual([]);
  });

  it("does not treat Object.prototype names as known", () => {
    const raw = parse("constructor: 1\ntoString: 2\n");
    expect(lintUnknownMetadataKeys(raw)).toHaveLength(2);
  });
});

describe("rewriteMetadata", () => {
  const run = {
    test_results: { last_tested: "2026-09-29", health_check_passed: true },
    images: [{ name: "app:1", size_mb: 10, platform: ["linux/arm64"] }],
  };

  it("replaces test_results and images and keeps every other key, unknown ones included", () => {
    const before = parse(`
tagline: A thing
knwon_issues:
  - "kept verbatim"
test_results:
  last_tested: 2020-01-01
  stale_field: gone
images:
  - name: old:0
`) as Record<string, unknown>;
    const after = parse(rewriteMetadata(before, run));
    expect(after).toEqual({
      tagline: "A thing",
      knwon_issues: ["kept verbatim"],
      test_results: run.test_results,
      images: run.images,
    });
    expect(Object.keys(after)).toEqual(["tagline", "knwon_issues", "test_results", "images"]);
  });

  it("adds test_results and images to a file that has neither", () => {
    const after = parse(rewriteMetadata({ publisher: "upstream" }, run));
    expect(after).toEqual({ publisher: "upstream", ...run });
  });
});

describe("KNOWN_METADATA_KEYS", () => {
  it("matches the key table in catalog/test/README.md", () => {
    const readme = readFileSync(
      fileURLToPath(new URL("../README.md", import.meta.url)),
      "utf-8",
    );
    const section = readme.split("### Top-level keys")[1]?.split("\n### ")[0] ?? "";
    const documented = [...section.matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1]);
    expect(documented.length).toBeGreaterThan(0);
    expect([...documented].sort()).toEqual([...KNOWN_METADATA_KEYS].sort());
  });
});
