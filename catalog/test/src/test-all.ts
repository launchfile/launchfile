#!/usr/bin/env bun
/**
 * Batch test runner for catalog apps. Runs apps tier by tier, smallest first.
 *
 * Usage: bun run src/test-all.ts [--tier N] [--dry-run] [--url <public-url>]
 *
 * `--url` is forwarded to every app (see test-app.ts). Apps that require an
 * `https-origin` (D-60) cannot run without an `https://` value, so they are
 * reported as skipped, neither passed nor failed, when `--url` is absent or
 * not `https://`.
 *
 * Tiers are derived from the catalog directories: every
 * directory under catalog/{apps,drafts}/ runs except those in `SKIPPED`
 * (build-index.ts), in the tier `tierOf` gives it — 0 = no backing services,
 * 1 = postgres only, 2 = any other service mix, 3 = two components,
 * 4 = three or more.
 */

import { resolve } from "node:path";
import { buildTiers, loadEntries } from "./build-index.ts";
import { httpsOriginSatisfied, InvalidAppUrlError } from "../../../providers/docker/src/app-url.ts";

const ENTRIES = loadEntries(resolve(import.meta.dir, "..", ".."));
const TIERS = buildTiers(ENTRIES);
const NEEDS_HTTPS_ORIGIN = new Set(ENTRIES.filter((e) => e.requiresHttpsOrigin).map((e) => e.slug));

// --- CLI args ---

const args = process.argv.slice(2);
const tierFlag = args.find((a) => a.startsWith("--tier=") || a.startsWith("--tier "));
const tierArg = tierFlag
  ? tierFlag.split("=")[1]
  : args[args.indexOf("--tier") + 1];
const selectedTier = tierArg !== undefined ? Number.parseInt(tierArg, 10) : undefined;
const dryRun = args.includes("--dry-run");
const urlFlag = args.find((a) => a.startsWith("--url="));
const appUrl = urlFlag
  ? urlFlag.slice("--url=".length)
  : args.includes("--url")
    ? args[args.indexOf("--url") + 1]
    : undefined;
// A malformed --url is not a skip: test-app.ts refuses it and reports a failure.
const originSatisfied = (() => {
  try {
    return httpsOriginSatisfied(appUrl);
  } catch (e) {
    if (e instanceof InvalidAppUrlError) return true;
    throw e;
  }
})();
const extraFlags = [
  ...(dryRun ? ["--dry-run"] : []),
  ...(appUrl ? ["--url", appUrl] : []),
];

// --- Run ---

interface Result {
  app: string;
  tier: number;
  passed: boolean;
  duration: number;
  error?: string;
  /** Reason the app was not run; a skipped app is neither passed nor failed. */
  skipped?: string;
}

const results: Result[] = [];

const tiersToRun =
  selectedTier !== undefined
    ? { [selectedTier]: TIERS[selectedTier] }
    : TIERS;

for (const [tierNum, tier] of Object.entries(tiersToRun)) {
  if (!tier) {
    console.error(`Unknown tier: ${tierNum}`);
    process.exit(1);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`TIER ${tierNum}: ${tier.name} (${tier.apps.length} apps)`);
  console.log("=".repeat(60));

  for (const app of tier.apps) {
    const start = performance.now();
    console.log(`\n--- ${app} ---`);

    if (NEEDS_HTTPS_ORIGIN.has(app) && !originSatisfied) {
      const skipped = "requires https-origin (D-60); pass --url https://<host> to run";
      console.log(`SKIP: ${skipped}`);
      results.push({ app, tier: Number(tierNum), passed: false, duration: 0, skipped });
      continue;
    }

    try {
      const proc = Bun.spawn(
        ["bun", "run", "src/test-app.ts", app, ...extraFlags],
        {
          cwd: import.meta.dir.replace("/src", ""),
          stdout: "inherit",
          stderr: "inherit",
        },
      );

      const exitCode = await proc.exited;
      const duration = Math.round((performance.now() - start) / 1000);

      results.push({
        app,
        tier: Number(tierNum),
        passed: exitCode === 0,
        duration,
      });
    } catch (err) {
      const duration = Math.round((performance.now() - start) / 1000);
      results.push({
        app,
        tier: Number(tierNum),
        passed: false,
        duration,
        error: String(err),
      });
    }
  }
}

// --- Summary ---

console.log(`\n${"=".repeat(60)}`);
console.log("SUMMARY");
console.log("=".repeat(60));

const maxAppLen = Math.max(...results.map((r) => r.app.length));
console.log(
  `${"App".padEnd(maxAppLen)}  Tier  Result  Time`,
);
console.log("-".repeat(maxAppLen + 25));

for (const r of results) {
  if (r.skipped) {
    console.log(`${r.app.padEnd(maxAppLen)}  T${r.tier}    - SKIP  ${r.skipped}`);
    continue;
  }
  const status = r.passed ? "PASS" : "FAIL";
  const icon = r.passed ? "+" : "x";
  console.log(
    `${r.app.padEnd(maxAppLen)}  T${r.tier}    ${icon} ${status}  ${r.duration}s`,
  );
}

const passed = results.filter((r) => r.passed).length;
const skipped = results.filter((r) => r.skipped).length;
const failed = results.length - passed - skipped;
console.log(`\nTotal: ${passed} passed, ${failed} failed, ${skipped} skipped out of ${results.length}`);

process.exit(failed > 0 ? 1 : 0);
