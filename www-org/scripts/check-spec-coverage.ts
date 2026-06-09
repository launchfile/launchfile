#!/usr/bin/env bun
/**
 * check-spec-coverage — enforce that every Launchfile schema field is reachable
 * at a predictable URL under /spec/.
 *
 * Runs in prebuild. Catches three real failure modes:
 *   1. Schema field added but no ## section in SPEC.md.
 *   2. Schema field documented but no sidebar entry in navigation.ts.
 *   3. Sidebar href points at a slug with no matching SPEC.md section.
 *
 * Slug convention: kebab-cased YAML key, verbatim, unless listed in
 * SLUG_OVERRIDES in spec-sections.ts (e.g. `env` → prose heading "Environment
 * Variables", URL /spec/env/).
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { navigation } from "../src/lib/navigation";
import {
  SLUG_OVERRIDES,
  getSpecSections,
} from "../src/lib/spec-sections";

/**
 * Schema fields that intentionally do not have their own page. Value = slug of
 * the parent section where the field is documented. A field without an entry
 * here is expected to have a dedicated `/spec/<slug>/` page.
 */
const ABSORBED_FIELDS: Record<string, string> = {
  // Metadata fields listed in the Top-Level Fields table
  version: "top-level-fields",
  generator: "top-level-fields",
  name: "top-level-fields",
  description: "top-level-fields",
  repository: "top-level-fields",
  website: "top-level-fields",
  logo: "top-level-fields",
  keywords: "top-level-fields",
  // Per-component options grouped under Other Fields
  restart: "other-fields",
  schedule: "other-fields",
  singleton: "other-fields",
  platform: "other-fields",
};

function toSlug(fieldName: string): string {
  const defaultSlug = fieldName.toLowerCase().replace(/_/g, "-");
  return SLUG_OVERRIDES[defaultSlug] ?? defaultSlug;
}

async function main(): Promise<void> {
  const errors: string[] = [];

  // 1. Load the schema — source of truth for what fields exist.
  const schemaPath = resolve(
    process.cwd(),
    "../spec/schema/launchfile.schema.json",
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
    properties: Record<string, unknown>;
  };
  const schemaFields = Object.keys(schema.properties ?? {});

  // 2. Load SPEC.md sections and the sidebar hrefs.
  const sections = await getSpecSections();
  const sectionSlugs = new Set(sections.map((s) => s.slug));

  const specGroup = navigation.find((g) => g.title === "Specification");
  if (!specGroup) {
    errors.push('navigation.ts has no "Specification" group.');
  }
  const sidebarHrefs = new Set(specGroup?.items.map((i) => i.href) ?? []);

  // 3. Every schema field must either have its own page or be absorbed.
  for (const field of schemaFields) {
    const absorbedParent = ABSORBED_FIELDS[field];
    if (absorbedParent) {
      if (!sectionSlugs.has(absorbedParent)) {
        errors.push(
          `Schema field "${field}" is marked absorbed into "${absorbedParent}", but no ## section with that slug exists in SPEC.md.`,
        );
      }
      continue;
    }

    const slug = toSlug(field);
    if (!sectionSlugs.has(slug)) {
      errors.push(
        `Schema field "${field}" has no ## section in SPEC.md (expected slug "${slug}"). Add one, or list the field in ABSORBED_FIELDS.`,
      );
    }
    if (!sidebarHrefs.has(`/spec/${slug}/`)) {
      errors.push(
        `Schema field "${field}" (slug "${slug}") has no sidebar entry under "Specification" in navigation.ts.`,
      );
    }
  }

  // 4. Every sidebar entry under Specification must resolve to a real page.
  for (const item of specGroup?.items ?? []) {
    const match = item.href.match(/^\/spec\/([^/]*)\/?$/);
    if (!match) {
      errors.push(
        `Sidebar entry "${item.title}" has an unexpected href: ${item.href}`,
      );
      continue;
    }
    const slug = match[1];
    if (slug === "") continue; // /spec/ → spec overview index page, no ## section
    if (!sectionSlugs.has(slug)) {
      errors.push(
        `Sidebar entry "${item.title}" → ${item.href} has no matching ## section in SPEC.md.`,
      );
    }
  }

  // 5. Report.
  if (errors.length > 0) {
    console.error("\n✗ Spec coverage check failed:\n");
    for (const err of errors) console.error(`  - ${err}`);
    console.error(
      "\nFix: add the missing ## section to spec/SPEC.md, add the missing sidebar entry to www-org/src/lib/navigation.ts, or list the field in ABSORBED_FIELDS in this script.\n",
    );
    process.exit(1);
  }

  console.log(
    `✓ Spec coverage: ${schemaFields.length} schema fields, ${sections.length} sections, ${specGroup?.items.length} sidebar entries — all reachable.`,
  );
}

await main();
