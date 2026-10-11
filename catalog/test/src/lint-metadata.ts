/**
 * Top-level `metadata.yaml` keys the catalog reads, and a warn-only lint for
 * the rest (#422).
 *
 * `metadata.yaml` has no schema. A misspelt key (`knwon_issues:`) is read by
 * nothing and reported by nothing, so the note it carries is silently lost.
 * The lint names such a key and says it is ignored. It never fails a run:
 * unknown vocabulary is a warning, not an error (D-46's posture, and
 * `lintUnknownStorageKeys` in `sdk/src/lint.ts`, which this mirrors).
 *
 * The set is documented in `catalog/test/README.md` § Metadata, and a test
 * holds the two equal.
 */

import { stringify } from "yaml";

export const KNOWN_METADATA_KEYS = [
  "tagline",
  "homepage",
  "category",
  "publisher",
  "known_issues",
  "test_env",
  "test_storage",
  "test_results",
  "images",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Warn on each unrecognized top-level key of a parsed `metadata.yaml`.
 * `raw` is the document as `yaml.parse` returns it; anything that is not a
 * mapping yields no warnings. `file` prefixes each message.
 */
export function lintUnknownMetadataKeys(raw: unknown, file = "metadata.yaml"): string[] {
  if (!isPlainObject(raw)) return [];
  const known: readonly string[] = KNOWN_METADATA_KEYS;
  return Object.keys(raw)
    .filter((key) => !known.includes(key))
    .map(
      (key) =>
        `${file}: unrecognized top-level key "${key}" ` +
        `(known: ${KNOWN_METADATA_KEYS.join(", ")}) — unknown keys are ignored ` +
        "by the catalog and its test harness",
    );
}

export interface MetadataRunResults {
  test_results: Record<string, unknown>;
  images: Record<string, unknown>[];
}

/**
 * Serialize `metadata` with `test_results` and `images` replaced by this
 * run's values. Every other top-level key — known or not — is kept as is, so
 * a hand-written key survives the harness rewriting the file.
 */
export function rewriteMetadata(
  metadata: Record<string, unknown>,
  run: MetadataRunResults,
): string {
  return stringify(
    { ...metadata, test_results: run.test_results, images: run.images },
    { lineWidth: 120 },
  );
}
