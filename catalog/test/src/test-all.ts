#!/usr/bin/env bun
/**
 * Batch test runner for catalog apps. Runs apps tier by tier, smallest first.
 *
 * Usage: bun run src/test-all.ts [--tier N] [--dry-run] [--url <public-url>]
 *
 * `--url` is forwarded to every app (see test-app.ts). Apps that declare a
 * required `https-origin` fail without an `https://` value, exactly as they
 * would on the shipped Docker provider.
 *
 * Tiers are derived from the catalog directories: every
 * directory under catalog/{apps,drafts}/ runs except those in `SKIPPED`
 * (build-index.ts), in the tier `tierOf` gives it — 0 = no backing services,
 * 1 = postgres only, 2 = any other service mix, 3 = two components,
 * 4 = three or more.
 */

import { resolve } from "node:path";
import { buildTiers, loadEntries } from "./build-index.ts";
import { parseTier } from "./cli-args.ts";

const TIERS = buildTiers(loadEntries(resolve(import.meta.dir, "..", "..")));

// --- CLI args ---

const args = process.argv.slice(2);
let selectedTier: number | undefined;
try {
  selectedTier = parseTier(args);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const dryRun = args.includes("--dry-run");
const urlFlag = args.find((a) => a.startsWith("--url="));
const appUrl = urlFlag
  ? urlFlag.slice("--url=".length)
  : args.includes("--url")
    ? args[args.indexOf("--url") + 1]
    : undefined;
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
  const status = r.passed ? "PASS" : "FAIL";
  const icon = r.passed ? "+" : "x";
  console.log(
    `${r.app.padEnd(maxAppLen)}  T${r.tier}    ${icon} ${status}  ${r.duration}s`,
  );
}

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\nTotal: ${passed} passed, ${failed} failed out of ${results.length}`);

process.exit(failed > 0 ? 1 : 0);
