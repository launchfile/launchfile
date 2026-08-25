# launchfile

Describe your app. Deploy it anywhere.

```bash
npx launchfile up ghost
# Ghost is running at http://localhost:2368
```

One command to run any app from the [Launchfile catalog](https://launchfile.io/apps/) — databases, services, and env vars wired automatically.

## Install

```bash
# Zero-install via npx
npx launchfile up ghost

# Or install globally
npm install -g launchfile
```

## Commands

```
launchfile up [slug|path]        Start an app (Docker or native)
launchfile down [id|slug]        Stop a deployment
launchfile status [id|slug]      Show deployment status
launchfile logs [id|slug]        View logs
launchfile diagnose [id|slug]    Explain why the last launch failed
launchfile list                  List all deployments
launchfile validate [path]       Validate a Launchfile
launchfile inspect [path]        Print normalized JSON
launchfile schema                Dump JSON Schema
```

## Examples

```bash
# Run a catalog app
launchfile up ghost              # Ghost + MySQL
launchfile up memos              # Memos (standalone, 49MB)
launchfile up miniflux           # Miniflux + Postgres

# Run the app in the current directory
cd my-project
launchfile up

# Choose your provider
launchfile up --docker           # Docker (default if available)
launchfile up --native           # macOS native (Homebrew services)

# Diagnose a failure after the fact
launchfile diagnose              # Explain the last failed launch
launchfile diagnose --json       # The same record, machine-readable on stdout

# Clean up
launchfile down                  # Stop containers
launchfile down --destroy        # Remove everything

# Reduced-portability warnings (D-40, D-43) — validate-only, non-fatal
launchfile validate --detached   # also flag source-needing apps with no repository:
LAUNCHFILE_NO_PORTABILITY_WARNINGS=1 launchfile validate   # silence both (any value except "0"/"false")
```

## Architecture

```
src/
  cli.ts                — Main entry point, routes all verbs
  commands/
    up.ts               — Resolves target, detects provider, delegates, registers deployment
    down.ts             — Resolves deployment, delegates, updates index
    status.ts           — Resolves deployment, shows status
    logs.ts             — Resolves deployment, streams logs
    list.ts             — Reads index, prints table, auto-migrates old state
    diagnose.ts         — Reads the last captured launch failure, renders it
  state/
    index.ts            — Deployment index manager (~/.launchfile/deployments/)
    deployment-id.ts    — 7-char hex ID generation
    errors.ts           — Launch-failure records (~/.launchfile/errors/)
    types.ts            — DeploymentIndex, DeploymentEntry interfaces
  detect-provider.ts    — Docker/macOS auto-detection
  resolve-target.ts     — Slug vs path vs pwd vs deployment ID resolution
```

## State

All state lives at `~/.launchfile/deployments/`. Each deployment gets a short hash ID (e.g., `a3f2b1c`) and its own directory with `state.json` and provider artifacts.

Failed launches are recorded separately at `~/.launchfile/errors/<key>.json`, one per app, with `last.json` pointing at the most recent. Records hold command output and log tails, so they are written `0600` inside a `0700` directory. Secrets are masked as the record is written, in the process that still knows them; the record stores environment variable *names* only. A successful `up` supersedes the record for that app, and `down --destroy` removes it.

## Links

- [Catalog](https://launchfile.io/apps/) — Ready-to-launch apps
- [Docs](https://launchfile.dev) — Developer documentation
- [Specification](https://launchfile.org) — The Launchfile format
- [GitHub](https://github.com/launchfile/launchfile)
