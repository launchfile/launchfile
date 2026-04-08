# Launchfile

An open specification for describing application deployment requirements.

## Monorepo Structure

This repo contains independently-splittable packages and two websites:

- `spec/` — The specification document, JSON Schema, design docs, examples
- `sdk/` — TypeScript reference parser, validator, and serializer
- `providers/` — Reference provider implementations (Docker, macOS dev)
- `packages/` — Published npm packages (`launchfile` unified CLI)
- `catalog/` — Community Launchfiles for popular open-source apps
- `brand/` — Logos, colors, social cards, and design assets
- `smoke-tests/` — Post-publish smoke tests for npm packages and websites

### Websites

Two Astro + Tailwind v4 sites share `www-shared/` layouts and `brand/` tokens:

| Directory | Domain | Purpose |
|-----------|--------|---------|
| `www-dev/` | launchfile.dev | Developer docs, SDK reference, examples |
| `www-org/` | launchfile.org | Specification, design principles, governance |
| `www-shared/` | — | Shared layouts, components, global CSS |

All deploy to Cloudflare Pages (static output). Build from repo root: `cd www-{dev,org} && bun run build`.

**launchfile.io** hosts the app catalog and managed hosting — see [launchfile.io](https://launchfile.io).

Each directory has its own `CLAUDE.md` with directory-specific context (where applicable).

## Commit Conventions

This monorepo is designed for future splitting via `git subtree split`. To keep that clean:

- **One commit, one directory.** Every commit is scoped to exactly one top-level directory.
- **Prefix format:** `spec:`, `sdk:`, `providers:`, `packages:`, `catalog:`, `brand:`, `www-dev:`, `www-org:`, `www-shared:`, or `chore:` (for root-level files).
- **Cross-cutting changes** become multiple commits (e.g., a spec change + SDK update = 2 commits).
- **Commit bodies** explain *why*, not just *what*.

## Key Naming

- The file is called `Launchfile` (no extension). It contains YAML.
- Simple, intuitive, self-describing — like Dockerfile, Makefile, Procfile.

## Commands

```bash
# SDK development
cd sdk && bun install && bun test

# macOS dev provider
cd providers/macos-dev && bun install && bun test

# Website development (pick a site)
cd www-dev && bun install && bun run dev   # launchfile.dev
cd www-org && bun install && bun run dev   # launchfile.org
```
