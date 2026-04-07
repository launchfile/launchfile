# Docker Provider — Working Context

> For project-wide context, see [../../CLAUDE.md](../../CLAUDE.md)

## What's Here

A Launchfile provider that runs apps via Docker Compose. Generates a docker-compose.yml from a Launchfile and manages the lifecycle with `docker compose`.

## Philosophy

- **Image-first** — uses `image:` field, generates backing services as Docker containers
- **Zero-install** — works via `npx launchfile up ghost`
- **100% cleanable** — `down --destroy` removes all containers, volumes, and networks
- **Catalog-friendly** — accepts app slugs, URLs, or local Launchfile paths

## Commands

```bash
bun install        # Install dependencies
bun test           # Run all tests (vitest)
bun run typecheck  # Type-check without emitting
```

This package is a library consumed by the unified `launchfile` CLI (`packages/launchfile`). End users run `npx launchfile up ghost`, not this package directly.

## Architecture

- `cli.ts` — CLI entry point, parses commands and flags
- `provider.ts` — Main orchestration (up, down, status, logs, list)
- `compose-generator.ts` — Launchfile → docker-compose.yml translation
- `source-resolver.ts` — Resolves slugs, URLs, or paths to Launchfile YAML
- `port-allocator.ts` — Finds available host ports for container bindings
- `state.ts` — Persists state at `~/.launchfile/docker/{slug}/`
- `prereqs.ts` — Checks Docker and docker compose availability
- `shell.ts` — Shell execution helper

## State Location

`~/.launchfile/docker/{slug}/` contains:
- `docker-compose.yml` — generated compose file
- `state.json` — secrets, ports, timestamps

## Dependencies

- `@launchfile/sdk` — Parsing, validation, expression resolution
- `yaml` — YAML serialization for compose output
