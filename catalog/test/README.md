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

# Regenerate the README app tables from the directories
bun run build-index

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

Tiers are derived from each Launchfile (`tierOf` in `src/build-index.ts`), not listed
by hand. Every directory under `catalog/{apps,drafts}/` runs, except the ones in
`SKIPPED` (same file), which need something the harness cannot supply (host access, a
GPU, a claim token).

| Tier | Description | Rule |
|------|-------------|------|
| 0 | Zero dependencies | One component, no backing services |
| 1 | Postgres only | One component, requires only `postgres` |
| 2 | Mixed backing services | One component, any other set of required services |
| 3 | Multi-component | Two components |
| 4 | Complex | Three or more components |

`https-origin` and host-capability requirements are not backing services and do not
affect the tier.

## Catalog index

`src/build-index.ts` rewrites the Tested Apps and Proposed Apps tables in
`catalog/README.md` between their `BEGIN GENERATED` / `END GENERATED` markers, from the
directories themselves: category and tagline from `metadata.yaml` (the Launchfile
`description` when there is no tagline), services from every component's
`requires[].type`, and gaps from the open `### G-N` entries in `catalog/GAPS.md`.

```bash
bun run build-index           # rewrite catalog/README.md
bun run build-index --check   # exit 1 if catalog/README.md is stale
```

`src/build-index.test.ts` makes the same comparison, so `bun run test` fails on a stale
table.

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

### `test_storage:` — the harness's operator channel for volumes

A volume marked `content: operator` (D-50) holds content only a person can
supply, so the provider binds a directory the operator passes at launch or
refuses the component — it never starts the app over an empty directory. The
harness is an operator, so it supplies that directory from a `test_storage:`
block you write by hand:

```yaml
test_storage:
  config: test/config
```

The key is the volume name (`<component>.<volume>` when the bare name is
ambiguous). The value is a path **relative to the app's directory**; the
harness resolves it to an absolute host path before the translator sees it, so
no host path ever enters the `Launchfile` or `metadata.yaml`. Commit the
fixture. A marked volume with no `test_storage:` entry — or one whose path is
not readable — **fails the app's test run by name**, before any image is
pulled, and the same check runs across every app in `catalog/apps/` in
`launch-to-compose.test.ts`. A `test_storage:` key that matches no
`content: operator` volume is ignored with a warning, so a misspelled volume
name surfaces as the unbound volume it left behind, not as a silent success.

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
