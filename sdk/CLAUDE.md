# Launchfile SDK — Working Context

> For project-wide context, see [../CLAUDE.md](../CLAUDE.md)

## What's Here

TypeScript reference implementation for parsing, validating, and serializing Launchfiles.

## Commands

```bash
bun install        # Install dependencies
bun test           # Run all tests (vitest)
bun run typecheck  # Type-check without emitting
bun run lint       # Biome linter
bun run build      # Compile to dist/
```

## Public API

See [`README.md`](./README.md) → "API" for the full, checked list. Every value
export of `src/index.ts` is a row there or an explicit exclusion in
`scripts/check-readme-exports.ts` — `bun run check:exports` fails `bun run
test` (and CI's `sdk` job) if the two go out of sync, so this file doesn't
keep a second copy of the list.

## Architecture

- `types.ts` — All type definitions (Launch, Component, Normalized* variants)
- `schema.ts` — Zod validation schemas with shorthand support
- `reader.ts` — YAML → validated → normalized pipeline
- `writer.ts` — Normalized → compact YAML with shorthand collapse
- `resolver.ts` — $expression parser and resolver (pure TypeScript, no deps)

## Dependencies

- `zod` — Runtime validation
- `yaml` — YAML parsing and serialization
- No other runtime dependencies

## Publishing

Package name: `@launchfile/sdk` on npm. Published from `sdk/` directory.

Note: the unscoped `launchfile` npm package is the unified CLI (`packages/launchfile`), not this SDK.
