# Changelog

## 0.1.x (2026-04-05 — 2026-04-08)

Initial development releases. Established the core SDK, CLI, providers, and infrastructure.

### @launchfile/sdk (0.1.0 — 0.1.4)

- YAML parser, Zod validator, and serializer for Launchfiles
- Expression syntax: `$prop`, `${prop}`, `${prop:-default}`, cross-component refs
- CLI commands: `validate`, `inspect`, `schema`
- Input hardening against untrusted YAML

### launchfile CLI (0.1.0 — 0.1.7)

- Unified CLI wrapping the SDK: `launchfile up/down/status/logs/list`
- Provider auto-detection (Docker, macOS dev)
- Deployment state management with unique IDs
- Re-exports SDK public API for convenience imports

### @launchfile/docker (0.1.3 — 0.1.4)

- Docker Compose generation from Launchfiles
- Volume, port, and environment mapping
- Health check translation

### @launchfile/macos-dev (0.1.3 — 0.1.4)

- Local macOS development provider
- Homebrew service management
- Secrets written with restricted file permissions

---

*Changelog entries above this line were written manually. Entries below are managed by [Changesets](https://github.com/changesets/changesets).*

## v1 — 2026-04-05

Initial specification release.

- 13 design principles and 21 documented design decisions
- Full spec: components, requires, supports, env, commands, health, secrets, storage, provides
- Expression syntax with `$prop`, `${prop}`, `${prop:-default}`, and cross-component references
- JSON Schema for validation and IDE autocompletion
- TypeScript reference SDK (parser, validator, resolver, serializer)
- Catalog of Launchfiles for popular open-source apps
- Constitutional AI governance model
