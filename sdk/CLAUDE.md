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

```typescript
import {
  readLaunch,       // Parse YAML string → NormalizedLaunch
  validateLaunch,   // Validate parsed object → NormalizedLaunch
  writeLaunch,      // NormalizedLaunch → compact YAML string
  parseExpression,  // Parse $prop expression → AST
  resolveExpression,// Resolve expression against context → string
  isExpression,     // Check if string contains $ references
  parseDotPath,     // Parse "a.b.c" → ["a", "b", "c"]
  LaunchSchema,     // Zod schema for validation
} from "launchfile";
```

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
