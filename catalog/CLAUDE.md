# Launchfile Catalog — Working Context

> For project-wide context, see [../CLAUDE.md](../CLAUDE.md)

## What's Here

Community-maintained Launchfiles for popular open-source applications. Each app has its own directory under `apps/` containing a single `Launchfile`.

Apps in `apps/` are **tested and verified** — they have been confirmed to launch successfully. Proposed (untested) apps are tracked in the README.

## Directory Convention

```
apps/
  <app-name>/
    Launchfile      # Tested and verified
drafts/
  <app-name>/
    Launchfile      # Untested — work in progress
```

App names are kebab-case, matching the `name:` field inside the Launchfile.

- `apps/` — **tested and verified** Launchfiles that launch successfully
- `drafts/` — **untested** Launchfiles with initial structure, ready for iteration

### Promotion workflow

1. Pick a draft: `catalog/drafts/<app>/Launchfile`
2. Test it locally (e.g. docker compose, validate against schema)
3. Once verified: `git mv catalog/drafts/<app> catalog/apps/<app>`

## Testing

Test harness in `test/` translates Launchfiles to docker-compose, launches them, and collects metadata.

```bash
cd test && bun install

# Test single app (generates compose, launches, health-checks, tears down)
bun run src/test-app.ts <app-name>
bun run src/test-app.ts <app-name> --dry-run   # compose only, no launch
bun run src/test-app.ts <app-name> --keep       # leave running

# Test by tier (0=no deps, 1=postgres, 2=mixed DBs, 3=multi-component)
bun run src/test-all.ts --tier 0
```

## Validation

All Launchfiles should validate against the schema:

```bash
cd ../sdk && bun run src/index.ts validate ../catalog/apps/<app>/Launchfile
```

## Known Gaps

`GAPS.md` tracks spec limitations discovered by testing apps. Each gap has a severity rating and lists affected apps.
