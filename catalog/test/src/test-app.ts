#!/usr/bin/env bun
/**
 * Test a single catalog app by generating docker-compose, launching it,
 * checking health, collecting metrics, and tearing it down.
 *
 * Usage: bun run src/test-app.ts <app-name> [--keep] [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse, stringify } from "yaml";
import { readLaunch } from "../../../sdk/src/reader.ts";
import { launchToCompose } from "./launch-to-compose.ts";

// --- CLI args ---

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

const appName = positional[0];
const keepRunning = flags.has("--keep");
const dryRun = flags.has("--dry-run");

if (!appName) {
  console.error("Usage: bun run src/test-app.ts <app-name> [--keep] [--dry-run]");
  process.exit(1);
}

// --- Locate the Launchfile ---

const catalogRoot = resolve(dirname(import.meta.dir), "..");
const appDir =
  existsSync(resolve(catalogRoot, "apps", appName, "Launchfile"))
    ? resolve(catalogRoot, "apps", appName)
    : existsSync(resolve(catalogRoot, "drafts", appName, "Launchfile"))
      ? resolve(catalogRoot, "drafts", appName)
      : null;

if (!appDir) {
  console.error(`No Launchfile found for "${appName}" in apps/ or drafts/`);
  process.exit(1);
}

const launchfilePath = resolve(appDir, "Launchfile");
console.log(`\n=== Testing: ${appName} ===`);
console.log(`Launchfile: ${launchfilePath}`);

// --- Parse and translate ---

const yamlContent = readFileSync(launchfilePath, "utf-8");
let launch;
try {
  launch = readLaunch(yamlContent);
  console.log(`Parsed OK — ${Object.keys(launch.components).length} component(s)`);
} catch (err) {
  console.error(`Parse failed:`, err);
  process.exit(1);
}

const result = launchToCompose(launch);

if (result.warnings.length > 0) {
  console.log(`\nWarnings:`);
  for (const w of result.warnings) {
    console.log(`  - ${w}`);
  }
}

console.log(`\nImages needed: ${result.images.length}`);
for (const img of result.images) {
  console.log(`  - ${img}`);
}

// --- Write compose file to temp dir ---

const tmpDir = resolve(import.meta.dir, "..", ".tmp", appName);
mkdirSync(tmpDir, { recursive: true });
const composePath = resolve(tmpDir, "docker-compose.yml");
writeFileSync(composePath, result.yaml);
console.log(`\nCompose file: ${composePath}`);

if (dryRun) {
  console.log("\n--- Dry run: compose file written, not launching ---");
  console.log(result.yaml);
  process.exit(0);
}

// --- Helper to run shell commands ---

async function run(
  cmd: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd ?? tmpDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = opts?.timeout ?? 300_000; // 5 min default
  const timer = setTimeout(() => proc.kill(), timeout);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return { stdout, stderr, exitCode };
}

// --- Pull images and measure time ---

console.log("\nPulling images...");
const pullStart = performance.now();
const pullResult = await run(["docker", "compose", "pull", "--quiet"], { timeout: 600_000 });
const pullTimeSeconds = Math.round((performance.now() - pullStart) / 1000);

if (pullResult.exitCode !== 0) {
  console.error(`Image pull failed:\n${pullResult.stderr}`);
  process.exit(1);
}
console.log(`Pull completed in ${pullTimeSeconds}s`);

// --- Measure image sizes ---

interface ImageInfo {
  name: string;
  size_mb: number;
  platform: string[];
}

const imageInfos: ImageInfo[] = [];
for (const img of result.images) {
  const inspect = await run(["docker", "image", "inspect", img, "--format", "{{.Size}} {{.Architecture}}"]);
  if (inspect.exitCode === 0) {
    const [sizeStr, arch] = inspect.stdout.trim().split(" ");
    const sizeMb = Math.round(Number.parseInt(sizeStr, 10) / 1024 / 1024);
    imageInfos.push({
      name: img,
      size_mb: sizeMb,
      platform: [arch ? `linux/${arch}` : "unknown"],
    });
  }
}

const totalDiskMb = imageInfos.reduce((sum, i) => sum + i.size_mb, 0);
console.log(`Total image disk: ${totalDiskMb} MB`);

// --- Launch ---

console.log("\nStarting containers...");
const upStart = performance.now();
const upResult = await run(["docker", "compose", "up", "-d", "--wait", "--wait-timeout", "120"], {
  timeout: 180_000,
});
const startupTimeSeconds = Math.round((performance.now() - upStart) / 1000);

let healthPassed = false;
let statusNote = "";

if (upResult.exitCode === 0) {
  healthPassed = true;
  console.log(`Containers healthy in ${startupTimeSeconds}s`);
} else {
  // Check if containers are at least running
  console.log(`docker compose up --wait exited ${upResult.exitCode}`);
  console.log(upResult.stderr.slice(-500));

  // Still check if the main service is running
  const ps = await run(["docker", "compose", "ps", "--status", "running", "--format", "{{.Name}}"]);
  if (ps.stdout.trim().length > 0) {
    statusNote = "Containers running but health check timed out";
    console.log(statusNote);
  } else {
    statusNote = "Containers failed to start";
    console.log(statusNote);
  }
}

// --- Collect logs on failure ---

if (!healthPassed) {
  console.log("\n--- Container logs (last 30 lines per service) ---");
  const logs = await run(["docker", "compose", "logs", "--tail", "30"]);
  console.log(logs.stdout.slice(-2000));
}

// --- Report ---

const passed = healthPassed ? "PASS" : "FAIL";
console.log(`\n=== ${appName}: ${passed} ===`);
console.log(`  Pull time:    ${pullTimeSeconds}s`);
console.log(`  Startup time: ${startupTimeSeconds}s`);
console.log(`  Disk usage:   ${totalDiskMb} MB`);

// --- Write/update metadata.yaml ---

const metadataPath = resolve(appDir, "metadata.yaml");
let metadata: Record<string, unknown> = {};
if (existsSync(metadataPath)) {
  metadata = parse(readFileSync(metadataPath, "utf-8")) ?? {};
}

metadata.test_results = {
  last_tested: new Date().toISOString().split("T")[0],
  pull_time_seconds: pullTimeSeconds,
  startup_time_seconds: startupTimeSeconds,
  total_disk_mb: totalDiskMb,
  health_check_passed: healthPassed,
  notes: statusNote,
};

metadata.images = imageInfos.map((i) => ({
  name: i.name,
  size_mb: i.size_mb,
  platform: i.platform,
}));

writeFileSync(metadataPath, stringify(metadata, { lineWidth: 120 }));
console.log(`\nMetadata written: ${metadataPath}`);

// --- Teardown ---

if (!keepRunning) {
  console.log("\nTearing down...");
  await run(["docker", "compose", "down", "-v", "--remove-orphans"], { timeout: 60_000 });
  rmSync(tmpDir, { recursive: true, force: true });
  console.log("Done.");
} else {
  console.log(`\nContainers left running. Compose file: ${composePath}`);
  console.log(`Tear down with: cd ${tmpDir} && docker compose down -v`);
}

process.exit(healthPassed ? 0 : 1);
