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

# Static checks only — schema + image-reference policy, nothing pulled or run
bun run validate-catalog

# The unit suite (Vitest — `bun test` is blocked by scripts/test-guard.ts)
bun run typecheck && bun run test
```

## Static validation

`src/validate-catalog.ts` reads every `catalog/{apps,drafts}/*/Launchfile`, parses it
with the SDK's `readLaunch` — the Zod schema in `sdk/src/schema.ts`, not the published
JSON Schema, which nothing yet asserts agrees with it (issue #179) — and applies the
image-reference policy in
[`catalog/CONTRIBUTING.md`](../CONTRIBUTING.md#image-references). A missing tag or an
`@sha256` digest is an error anywhere in the catalog; the `:latest`-without-rationale
and `metadata.yaml`-drift checks are warnings, and only apply to Launchfiles the change
under review touches. Set `CATALOG_DIFF_BASE=<sha>` to name the base to diff against —
CI sets it from the pull request; with it unset, no file counts as changed and the
warnings are not evaluated.

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

### Top-level keys

These are the top-level keys the catalog and this harness read. Any other key
prints a warning when `bun run src/test-app.ts <app>` or the unit suite reads the
file, and is otherwise ignored — a typo does not fail a run, but it is no longer
silent. The set lives in `src/lint-metadata.ts`, and a test keeps it equal to
this table.

| Key            | Written by                                                 |
|----------------|------------------------------------------------------------|
| `tagline`      | hand                                                       |
| `homepage`     | hand                                                       |
| `category`     | hand                                                       |
| `publisher`    | hand ([CONTRIBUTING](../CONTRIBUTING.md#image-references)) |
| `known_issues` | hand (below)                                               |
| `test_env`     | hand (below)                                               |
| `test_storage` | hand (below)                                               |
| `test_results` | the harness, rebuilt on every run                          |
| `images`       | the harness, rebuilt on every run                          |

The harness rewrites the file after a run. It replaces `test_results:` and
`images:` and keeps every other top-level key, unknown ones included.

### `test_env:` — the harness's operator channel

An `env.<NAME>: { required: true }` with no `default:`, no `generator:`, and no
resource binding is a value the **operator** supplies (D-52, PROVIDERS.md §10
rule 8). The harness is an operator, so it may supply one — from a `test_env:`
block you write by hand:

```yaml
test_env:
  SMTP_HOST: "mail.example.test"
```

These are declared test inputs, reviewable in the catalog PR. The harness never
guesses a value from a variable's name; a required variable with no `test_env:`
entry **fails the app's test run by name**, before any image is pulled. If a
value belongs in the Launchfile rather than in a fixture, give it a `default:`
or a `generator:` instead.

### `test_storage:` — fixtures for operator-supplied volumes

A storage volume marked `content: operator` (D-50) needs a host directory the
operator provides. The harness takes it from a `test_storage:` block that maps the
volume key to a path relative to the app's directory:

```yaml
test_storage:
  config: test/config
```

### `known_issues:` — why an app still does not come up

A draft can be declaration-correct and still fail to deploy, for a reason the
Launchfile cannot express. Record that in a top-level `known_issues:` list:

```yaml
known_issues:
  - "Does not deploy. The three Postgres DSNs point at a hand-authored sibling
    component, which `requires:` cannot bind to. Tracked by #236."
```

It is top level on purpose. `test_results:` and `images:` are rebuilt from
scratch on every run, so a note written inside `test_results.notes` does not
survive the next `bun run src/test-app.ts <app>`.

## Known Limitations

- `build:` components are skipped (no source code to build)
- `host:` requirements (docker socket, host networking, privileged) are skipped
- `schedule:` is ignored (containers run but won't cron)
- Required env vars without a value source must be declared in `test_env:` (see above) — the run fails by name otherwise
- Port mapping uses ephemeral host ports to avoid conflicts
