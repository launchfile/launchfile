# Catalog Test Harness

Translates Launchfiles to docker-compose.yml, spins them up, health-checks them, collects metrics, and tears them down.

## Quick Start

```bash
cd catalog/test
bun install

# Test a single app (dry run — generates compose, doesn't launch)
bun run src/test-app.ts memos --dry-run

# Test a single app (full run)
bun run src/test-app.ts memos

# Keep containers running after test
bun run src/test-app.ts memos --keep

# Test all apps in a tier
bun run src/test-all.ts --tier 0
```

## Tiers

| Tier | Description | Backing services |
|------|-------------|-----------------|
| 0 | Zero dependencies | None |
| 1 | Postgres only | postgres |
| 2 | Mixed databases | postgres, redis, mongodb, mysql |
| 3 | Multi-component | Multiple images per app |
| 4 | Complex (3+ components) | Multiple services + databases |

## What it does

1. Reads `catalog/{apps,drafts}/<name>/Launchfile`
2. Parses with the SDK (`readLaunch`)
3. Generates `docker-compose.yml` (backing services, env wiring, health checks)
4. Pulls images, starts containers, waits for health
5. Writes `metadata.yaml` alongside the Launchfile with timing and size data
6. Tears down containers and volumes

## Metadata

Each tested app gets a `metadata.yaml` with auto-collected metrics:

```yaml
test_results:
  last_tested: 2026-04-06
  pull_time_seconds: 15
  startup_time_seconds: 1
  total_disk_mb: 57
  health_check_passed: true
images:
  - name: corentinth/it-tools:latest
    size_mb: 57
    platform: [linux/arm64]
```

## Known Limitations

- `build:` components are skipped (no source code to build)
- `host:` requirements (docker socket, host networking, privileged) are skipped
- `schedule:` is ignored (containers run but won't cron)
- Required env vars without defaults get placeholder values
- Port mapping uses ephemeral host ports to avoid conflicts
