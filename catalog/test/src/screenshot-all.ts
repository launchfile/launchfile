#!/usr/bin/env bun
/**
 * Launch each app, take a homepage screenshot, and tear down.
 * Saves screenshots to catalog/{apps,drafts}/<app>/screenshot.png
 *
 * Usage: bun run src/screenshot-all.ts [app1 app2 ...]
 *
 * If no args, runs all previously-passing apps (those with health_check_passed in metadata).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse } from "yaml";

const catalogRoot = resolve(dirname(import.meta.dir), "..");
const testDir = resolve(catalogRoot, "test");

// Get list of apps to screenshot
let apps = process.argv.slice(2).filter((a) => !a.startsWith("--"));

if (apps.length === 0) {
  // Find all apps with passing test results
  for (const subdir of ["apps", "drafts"]) {
    const dir = resolve(catalogRoot, subdir);
    if (!existsSync(dir)) continue;
    for (const entry of new Bun.Glob("*/metadata.yaml").scanSync({ cwd: dir })) {
      const metaPath = resolve(dir, entry);
      try {
        const meta = parse(readFileSync(metaPath, "utf-8"));
        if (meta?.test_results?.health_check_passed) {
          apps.push(entry.replace("/metadata.yaml", ""));
        }
      } catch {
        // skip
      }
    }
  }
  console.log(`Found ${apps.length} previously-passing apps: ${apps.join(", ")}`);
}

interface Result {
  app: string;
  launched: boolean;
  screenshotted: boolean;
  error?: string;
}

const results: Result[] = [];

for (const app of apps) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`${app}`);
  console.log("=".repeat(50));

  const result: Result = { app, launched: false, screenshotted: false };

  // Step 1: Launch with --keep
  const launchProc = Bun.spawn(
    ["bun", "run", "src/test-app.ts", app, "--keep"],
    { cwd: testDir, stdout: "inherit", stderr: "inherit" },
  );
  const launchExit = await launchProc.exited;
  result.launched = launchExit === 0;

  if (!result.launched) {
    console.log(`${app}: launch failed, skipping screenshot`);
    // Still tear down
    const tmpDir = resolve(testDir, ".tmp", app);
    if (existsSync(resolve(tmpDir, "docker-compose.yml"))) {
      const down = Bun.spawn(["docker", "compose", "down", "-v", "--remove-orphans"], {
        cwd: tmpDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      await down.exited;
    }
    results.push(result);
    continue;
  }

  // Step 2: Screenshot
  const ssProc = Bun.spawn(
    ["bun", "run", "src/screenshot.ts", app],
    { cwd: testDir, stdout: "inherit", stderr: "inherit" },
  );
  const ssExit = await ssProc.exited;
  result.screenshotted = ssExit === 0;

  // Step 3: Tear down
  const tmpDir = resolve(testDir, ".tmp", app);
  console.log("Tearing down...");
  const down = Bun.spawn(
    ["docker", "compose", "down", "-v", "--remove-orphans"],
    { cwd: tmpDir, stdout: "pipe", stderr: "pipe" },
  );
  await down.exited;

  // Clean up tmp
  const { rmSync } = await import("node:fs");
  rmSync(tmpDir, { recursive: true, force: true });

  results.push(result);
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log("SCREENSHOT SUMMARY");
console.log("=".repeat(50));

const maxLen = Math.max(...results.map((r) => r.app.length));
for (const r of results) {
  const launch = r.launched ? "+" : "x";
  const ss = r.screenshotted ? "+" : "x";
  console.log(`${r.app.padEnd(maxLen)}  launch: ${launch}  screenshot: ${ss}`);
}

const ok = results.filter((r) => r.screenshotted).length;
console.log(`\n${ok}/${results.length} screenshots captured`);
