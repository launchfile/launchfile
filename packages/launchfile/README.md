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

# Clean up
launchfile down                  # Stop containers
launchfile down --destroy        # Remove everything
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
  state/
    index.ts            — Deployment index manager (~/.launchfile/deployments/)
    deployment-id.ts    — 7-char hex ID generation
    migrations.ts       — Migrates old provider state to unified format
    types.ts            — DeploymentIndex, DeploymentEntry interfaces
  detect-provider.ts    — Docker/macOS auto-detection
  resolve-target.ts     — Slug vs path vs pwd vs deployment ID resolution
```

## State

All state lives at `~/.launchfile/deployments/`. Each deployment gets a short hash ID (e.g., `a3f2b1c`) and its own directory with `state.json` and provider artifacts.

## Links

- [Catalog](https://launchfile.io/apps/) — Ready-to-launch apps
- [Docs](https://launchfile.dev) — Developer documentation
- [Specification](https://launchfile.org) — The Launchfile format
- [GitHub](https://github.com/launchfile/launchfile)
