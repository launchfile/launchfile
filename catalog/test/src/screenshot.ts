#!/usr/bin/env bun
/**
 * Take a screenshot of a running app's homepage.
 *
 * Usage: bun run src/screenshot.ts <app-name>
 *
 * Expects the app to already be running via test-app.ts --keep.
 * Finds the mapped port from docker compose, navigates to it, screenshots.
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { chromium } from "playwright";

const appName = process.argv[2];
if (!appName) {
  console.error("Usage: bun run src/screenshot.ts <app-name>");
  process.exit(1);
}

const tmpDir = resolve(import.meta.dir, "..", ".tmp", appName);
if (!existsSync(resolve(tmpDir, "docker-compose.yml"))) {
  console.error(`No running compose found at ${tmpDir}. Run test-app.ts --keep first.`);
  process.exit(1);
}

// Find the mapped host port from docker compose
async function getHostPort(): Promise<number | null> {
  const proc = Bun.spawn(
    ["docker", "compose", "ps", "--format", "json"],
    { cwd: tmpDir, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  // docker compose ps --format json outputs one JSON object per line
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const container = JSON.parse(line);
      // Look for the main app service (not backing services like postgres)
      if (container.Publishers && container.Publishers.length > 0) {
        // Skip backing service containers
        const name = container.Name || container.Service || "";
        if (name.includes("postgres") || name.includes("redis") || name.includes("mysql") ||
            name.includes("mongo") || name.includes("clickhouse") || name.includes("mariadb")) {
          continue;
        }
        // Find a published port
        for (const pub of container.Publishers) {
          if (pub.PublishedPort && pub.PublishedPort > 0) {
            return pub.PublishedPort;
          }
        }
      }
    } catch {
      // skip unparseable lines
    }
  }
  return null;
}

const port = await getHostPort();
if (!port) {
  console.error(`Could not find a mapped port for ${appName}. Is it running?`);
  process.exit(1);
}

const url = `http://localhost:${port}`;
console.log(`Screenshotting ${appName} at ${url}`);

// Ensure screenshots directory exists
const catalogRoot = resolve(dirname(import.meta.dir), "..");
const appDir =
  existsSync(resolve(catalogRoot, "apps", appName))
    ? resolve(catalogRoot, "apps", appName)
    : resolve(catalogRoot, "drafts", appName);

const screenshotPath = resolve(appDir, "screenshot.png");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

try {
  // Give the page up to 30s to load, accept self-signed certs
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  // Wait a bit for any JS rendering to settle
  await page.waitForTimeout(2000);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`Screenshot saved: ${screenshotPath}`);
} catch (err) {
  console.error(`Screenshot failed:`, err);
  // Try anyway with whatever loaded
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`Partial screenshot saved: ${screenshotPath}`);
  } catch {
    console.error(`Could not capture any screenshot.`);
  }
} finally {
  await browser.close();
}
