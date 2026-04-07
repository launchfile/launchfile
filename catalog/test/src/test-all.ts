#!/usr/bin/env bun
/**
 * Batch test runner for catalog apps. Runs apps tier by tier, smallest first.
 *
 * Usage: bun run src/test-all.ts [--tier N] [--dry-run]
 */

const TIERS: Record<number, { name: string; apps: string[] }> = {
  0: {
    name: "Zero dependencies (image only, no backing services)",
    apps: [
      "it-tools",
      "dashy",
      "privatebin",
      "stirling-pdf",
      "linkding",
      "memos",
      "uptime-kuma",
      "mealie",
      "anythingllm",
      "audiobookshelf",
      "navidrome",
      "flowise",    // supports: postgres (optional, works without)
      "freshrss",   // supports: postgres (optional, works without)
    ],
  },
  1: {
    name: "Postgres only",
    apps: [
      "miniflux",
      "fider",
      "umami",
      "langfuse",
      "gitea",
      "n8n",
      "metabase",
      "openclaw",
      "strapi",
      "redmine",
      "mattermost",
      "vaultwarden",
    ],
  },
  2: {
    name: "Postgres + Redis / MongoDB / MySQL",
    apps: [
      // postgres + redis
      "paperless",
      // mongodb
      "librechat",
      "rocketchat",
      // mysql
      "ghost",
      "bookstack",
      "wordpress",
    ],
  },
  3: {
    name: "Multi-component",
    apps: [
      "changedetection",
      "nextcloud",
      "immich",
    ],
  },
  4: {
    name: "Complex (3+ components)",
    apps: [
      "appwrite",
      "chatwoot",
      "dify",
      "hoppscotch",
      "penpot",
      "supabase",
    ],
  },
  // Skipped: home-assistant (multicast/device), pihole (host networking),
  // plex (claim token), diun (docker socket), calibre-web (host bind mount),
  // ollama-openwebui (GPU), jellyfin (/dev/dri), duplicati (host bind mount),
  // syncthing (host bind mount), hedgedoc (build only, no image)
};

// --- CLI args ---

const args = process.argv.slice(2);
const tierFlag = args.find((a) => a.startsWith("--tier=") || a.startsWith("--tier "));
const tierArg = tierFlag
  ? tierFlag.split("=")[1]
  : args[args.indexOf("--tier") + 1];
const selectedTier = tierArg !== undefined ? Number.parseInt(tierArg, 10) : undefined;
const dryRun = args.includes("--dry-run");
const extraFlags = dryRun ? ["--dry-run"] : [];

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
