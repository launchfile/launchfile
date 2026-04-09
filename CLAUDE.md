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

## Build & Packaging Rules

Past incidents: dist/cli.js missing from published packages, wrong dist/ paths, pagefind indexes not generated, source maps shipped to npm. These rules prevent recurrence.

### npm packages — what gets published

Every publishable package MUST have a `files` array in package.json. This is the allowlist of what npm publish ships. Without it, everything (src/, tests, maps) gets published.

| Package | npm name | `files` must include | `bin` |
|---------|----------|---------------------|-------|
| `sdk/` | `@launchfile/sdk` | `dist/**/*.js`, `dist/**/*.d.ts`, `schema/**`, `README.md` | — |
| `providers/docker/` | `@launchfile/docker` | `dist/**/*.js`, `dist/**/*.d.ts`, `README.md` | — |
| `providers/macos-dev/` | `@launchfile/macos-dev` | `dist/**/*.js`, `dist/**/*.d.ts`, `README.md` | — |
| `packages/launchfile/` | `launchfile` | `dist/**/*.js`, `dist/**/*.d.ts`, `README.md` | `dist/cli.js` |

Never include: `src/`, `**/__tests__/`, `*.map`, `tsconfig*.json`, `bun.lock`.

### CI build order

The CI pipeline must match dependency order: SDK → Providers → CLI. Each step must build before test (tests may import from dist/).

```
SDK (typecheck → build → test)
  ↓
Providers (build SDK first, then typecheck → build → test)
  ↓
CLI package (build SDK + providers first, then typecheck → build → test)
  ↓
Websites (need Node >= 22 for Astro 6, need wrangler.toml with pinned compat_date)
```

### Websites — Astro + Cloudflare

- Both sites use `output: "static"` with `@astrojs/cloudflare` adapter
- `astro check` (typecheck) spawns a Node process via miniflare — requires Node >= 22.12.0
- `wrangler.toml` must pin `compatibility_date` to avoid race with workerd binary releases
- Pagefind runs post-build: `astro build && pagefind --site dist/client`
- Deploy path is `dist/client/` (not `dist/`)

### Local pre-push validation

Before pushing, run this to catch CI failures locally:

```bash
# SDK
cd sdk && bun run typecheck && bun run build && bun test

# Providers
cd providers/docker && bun run typecheck && bun test
cd providers/macos-dev && bun run build && bun test

# CLI package
cd packages/launchfile && bun run typecheck && bun run build && bun test
```
