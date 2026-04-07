# @launchfile/sdk

TypeScript SDK for parsing, validating, and serializing [Launchfiles](../spec/SPEC.md).

## Install

```bash
bun add launchfile
# or
npm install launchfile
```

## CLI

The SDK includes a `launchfile` CLI for validating and inspecting Launchfiles.

```bash
# Validate a Launchfile (defaults to ./Launchfile)
launchfile validate
launchfile validate path/to/Launchfile

# Structured JSON output for CI pipelines
launchfile validate --json

# Silent mode — just the exit code
launchfile validate --quiet

# Print the normalized form (after shorthand expansion) as JSON
launchfile inspect path/to/Launchfile

# Dump the JSON Schema to stdout
launchfile schema
```

### Global flags

- `--no-color` — Disable colored output (also respects `NO_COLOR` env var)
- `--version` — Print version
- `--help` — Show usage

### Validate in CI

```yaml
# GitHub Actions
- run: npx launchfile validate --quiet
```

### Editor Integration

Add JSON Schema support for autocompletion and validation in your editor:

```yaml
# yaml-language-server: $schema=https://launchfile.dev/schema/v1
version: launch/v1
name: my-app
```

## Usage

### Parse a Launchfile

```typescript
import { readLaunch } from "launchfile";

const app = readLaunch(`
  name: my-app
  runtime: node
  requires: [postgres]
  commands:
    start: "node server.js"
  health: /health
`);

// app.components.default.requires → [{ type: "postgres" }]
// app.components.default.health → { path: "/health" }
```

### Validate pre-parsed data

```typescript
import { validateLaunch } from "launchfile";

const app = validateLaunch({
  name: "my-app",
  runtime: "node",
  requires: ["postgres"],
});
```

### Write back to YAML

```typescript
import { writeLaunch } from "launchfile";

const yaml = writeLaunch(app);
// Collapses shorthands: { type: "postgres" } → "postgres"
```

### Resolve expressions

```typescript
import { resolveExpression } from "launchfile";

const url = resolveExpression("postgresql://${host}:${port}/${name}", {
  resource: { host: "localhost", port: 5432, name: "mydb" },
});
// → "postgresql://localhost:5432/mydb"
```

### Check for expressions

```typescript
import { isExpression } from "launchfile";

isExpression("$url");           // true
isExpression("hello");          // false
isExpression("$$escaped");      // false (literal $)
```

## API

| Function | Description |
|----------|-------------|
| `readLaunch(yaml)` | Parse YAML string → validated, normalized `NormalizedLaunch` |
| `validateLaunch(data)` | Validate a parsed object → `NormalizedLaunch` |
| `writeLaunch(launch)` | Serialize `NormalizedLaunch` → compact YAML string |
| `parseExpression(value)` | Parse a `$`-expression into an AST |
| `resolveExpression(value, context)` | Resolve expression against a context → string |
| `isExpression(value)` | Check if a string contains `$` references |
| `parseDotPath(path)` | Parse `"a.b.c"` → `["a", "b", "c"]` |
| `LaunchSchema` | Zod schema for direct validation |

## Types

All types are exported:

```typescript
import type {
  Launch,
  NormalizedLaunch,
  Component,
  NormalizedComponent,
  Requirement,
  Provides,
  EnvVar,
  // ... see types.ts for full list
} from "launchfile";
```

## License

[MIT](../LICENSE)
