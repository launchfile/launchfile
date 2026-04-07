# macOS Dev Provider — Working Context

> For project-wide context, see [../../CLAUDE.md](../../CLAUDE.md)

## What's Here

A Launchfile provider that runs apps natively on macOS for local development. Uses Homebrew services for databases (postgres, redis, mysql, etc.) and native runtimes (node via fnm, python via pyenv, ruby via rbenv, bun via brew).

## Philosophy

- **Source-first** — ignores `image:`, uses `runtime:` + native package managers
- **Brew-first** — shared database services, app-specific databases namespaced by app name
- **Supports skip by default** — use `--with-optional` for optional resources

## Commands

```bash
bun install        # Install dependencies
bun test           # Run all tests (vitest)
bun run typecheck  # Type-check without emitting
```

This package is a library consumed by the unified `launchfile` CLI (`packages/launchfile`). End users run `npx launchfile up`, not this package directly.

## Architecture

- `provider.ts` — Main orchestration (`launch up` sequence)
- `env-writer.ts` — Resolves `$` expressions via SDK and writes `.env.local`
- `resources/` — Brew-based provisioners (postgres, redis, mysql, sqlite)
- `runtimes/` — Version manager integrations (fnm, pyenv, rbenv)
- `process-manager.ts` — Multi-component startup with topological sort and health waits
- `state.ts` — Persists secrets, ports, and credentials in `.launchfile/state.json`

## Dependencies

- `@launchfile/sdk` — Parsing, validation, expression resolution
- `semver` — Version constraint matching for brew formulae
