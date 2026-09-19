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

# Evaluate as if fetched standalone rather than read from the app's own
# checkout — enables the D-43 reduced-portability check (PROVIDERS.md §6)
launchfile validate --detached

# Print the normalized form (after shorthand expansion) as JSON
launchfile inspect path/to/Launchfile

# Dump the JSON Schema to stdout
launchfile schema
```

### Global flags

- `--no-color` — Disable colored output (also respects `NO_COLOR` env var)
- `--version` — Print version
- `--help` — Show usage

### Reduced-portability warnings (D-40, D-43)

`validate` warns, non-fatally, when a component has no portable build path
(`runtime` and/or `commands.build`/`commands.install`) or — with `--detached`
— is source-needing with no `repository:` to fall back to. Set
`LAUNCHFILE_NO_PORTABILITY_WARNINGS` (to any value except `0`/`false`) to
silence both; every other `validate` warning keeps firing. The `lintLaunch(launch, opts?)` SDK export takes the
same two options (`detached`, `suppressPortabilityWarnings`) directly.

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

Every value export of `src/index.ts` is either a row below or an entry in
`EXCLUDED_EXPORTS` (`scripts/check-readme-exports.ts`, with a one-line reason —
mostly CLI-command implementations and the provider error-context vocabulary).
`bun run check:exports` (wired as a `pretest` hook) fails `bun run test` — and
CI's `sdk` job — if a value export is undocumented, or if a row/exclusion goes
stale.

### Parse, validate, serialize

| Function | Description |
|----------|-------------|
| `readLaunch(yaml)` | Parse YAML string → validated, normalized `NormalizedLaunch` |
| `parseLaunchYaml(yaml)` | Parse YAML string → raw, un-normalized, un-validated data. Used internally by `readLaunch`; exposed for callers that need the document before validation strips unrecognized keys |
| `validateLaunch(data)` | Validate a parsed object → `NormalizedLaunch` |
| `writeLaunch(launch)` | Serialize `NormalizedLaunch` → compact YAML string |
| `LaunchSchema` | Zod schema for direct validation |
| `parseRepository(repository)` | Split a `repository` value at its `#` fragment → `{ url, ref }` |

### Expressions

| Function | Description |
|----------|-------------|
| `parseExpression(value)` | Parse a `$`-expression into an AST |
| `resolveExpression(value, context)` | Resolve expression against a context → string |
| `isExpression(value)` | Check if a string contains `$` references |
| `parseDotPath(path)` | Parse `"a.b.c"` → `["a", "b", "c"]` |
| `deriveAppUrlProperties(url)` | Split a URL into the `{ authority, scheme, tls }` triple `$app.*` expressions resolve against |

### Named endpoints (D-63)

`$app.endpoints.<name>.*` addresses one named published endpoint's public
address; `$components.<component>.<endpoint>.*` addresses a named listener from
inside the deployment.

| Function | Description |
|----------|-------------|
| `endpointProperties(provides, host, activeCertificates?)` | The `<endpoint>.{host, port, protocol, url}` map a provider registers for a component's named `provides` entries, reading each entry's *effective* listener (D-61 rule 2) |
| `appEndpointReferences(launch)` | Every `$app.endpoints…` reference in the file's `env:` defaults and `set_env:` values, in declaration order — so a provider can warn only about the endpoints the app actually asks for |
| `APP_ENDPOINT_PROPERTIES` | The properties `$app.endpoints.<name>.*` addresses: the standard `$app.*` set (D-33, D-35) less `name` |
| `UNPUBLISHED_APP_ENDPOINT` | The answer for an endpoint the provider publishes no address for (D-63 rule 4) — every property `""`, degrading as an unknown `$app.*` property does (L-4) |

### Publication context (D-58)

The orchestrator-supplied public URL a provider resolves `$app.*` from when
routing is owned upstream. A malformed value is refused, never degraded.

| Function | Description |
|----------|-------------|
| `normalizeAppUrl(value)` | Validate and normalize a supplied publication URL → the WHATWG serialization with a lone root path dropped. Idempotent; throws `InvalidAppUrlError` on anything but an absolute `http`/`https` URL with no userinfo, query, or fragment |
| `suppliedAppAddress(appUrl)` | The address a supplied URL determines (D-58 rule 2): `{ host, port, url, authority, scheme, tls }` — the `$app.*` set less `name` |
| `suppliedAppProperties(name, appUrl)` | `name` plus `suppliedAppAddress`, for a provider resolving the whole `$app.*` set in one step |
| `InvalidAppUrlError` | Thrown for a refused `appUrl` (D-58 rule 3). The constructor masks userinfo in the displayed value, so no refusal path can echo an embedded credential (D-18, CWE-532) |

### Listeners and certificates (D-61)

A `provides` entry's `protocol`/`port` are its **declared** listener; its
**effective** listener is what that listener speaks in the configuration the
deployment selected. They differ only when a bound `certificate` is active.

| Function | Description |
|----------|-------------|
| `effectiveListener(entry, activeCertificates?)` | Read one `provides` entry's listener in both readings. Omit `activeCertificates` and the entry reads as its baseline |
| `boundCertificate(entry)` | The certificate name an entry binds, in either spelling (`tls: server-cert` or `tls: { certificate: server-cert }`), else `undefined` |
| `certificateBindings(component)` | Every certificate binding on one component, as `provides` entry → certificate name |
| `CERTIFICATE` | The `supports:` entry type a `tls:` binding names — `type: certificate` (D-61 rule 1) |

### Resource uses

A `uses` item is either a bare token (`db`) or a single-key map (`{ db: cache }`)
naming one occurrence of a repeatable use. The **use key** — `db`, or `db.cache`
— is the prefix providers register properties under and `$<resource>.<use>.…`
addresses.

| Function | Description |
|----------|-------------|
| `declaredUse(item)` | Decode one `uses` item → `{ use, name? }` |
| `useKey(item)` | The use key of one item as written: `db`, or `db.cache` for `{ db: cache }` |
| `useKeyOf(declared)` | The use key of an already-decoded `DeclaredUse` |
| `useKeys(uses)` | The use keys of a `uses` list, in declaration order |
| `parseUseKey(key)` | Split a use key back into `{ use, name? }` |
| `formatUseKey(key)` | The spelling diagnostics use: `db` for a bare key, `db: cache` for a named one |
| `isRepeatableUse(type, use)` | Whether the standard vocabulary lets `use` occur more than once on one `type` entry; `undefined` outside the registry, where the provider decides (L-4) |
| `RESOURCE_USE_VOCABULARY` | Standard use vocabulary by resource type → use → the properties it registers. Advisory: lint warns, the schema never rejects |
| `UnresolvedUseError` | Thrown when a `$<resource>.<use>.<property>` path names a use the entry does not declare, or a property the use does not register. Not softened by `:-default` — the path is wrong, not empty |

### Command capture

One formatter for every surface a provider prints captures on, so `sensitive`
means the same thing on each (SPEC.md § Command Capture). Masking is display
only — keeping a value out of logs and state files is the provider redactor's
job.

| Function | Description |
|----------|-------------|
| `formatCaptures(captures, captureMeta, reveal, options?)` | The indented lines a provider prints for one command's captures. `reveal: true` prints every value; otherwise a `sensitive: true` entry prints as `CAPTURE_MASK`, and one `REVEAL_HINT` line follows unless `options.hint` is `false` |
| `sensitiveCaptureValues(captures, captureMeta)` | The values of every capture whose entry declares `sensitive: true` — what a provider registers with its redactor |
| `CAPTURE_MASK` | The mask a sensitive value displays as |
| `REVEAL_HINT` | The trailing line naming the command that prints masked values |

### Component selection

| Function | Description |
|----------|-------------|
| `selectComponents(launch, requested)` | Resolve a requested component/resource name list against the launch → known, unknown, and resource names |
| `selectionClosure(launch, requested)` | `selectComponents`, extended with the D-41 dependency-closure start set |

### Linting

`validate` runs these; call them directly to build a custom check.

| Function | Description |
|----------|-------------|
| `lintLaunch(launch, opts?)` | Run every structural/portability lint over a normalized launch → warning strings |
| `lintDeprecations(launch)` | Report deprecated fields present in the file (P-14/D-42), each carrying migration guidance |
| `lintDurations(launch)` | Check every duration-valued field against the ratified duration grammar (P-9) |
| `lintUnknownStorageKeys(raw)` | Check the raw (pre-normalization) document for `storage:` keys the schema doesn't recognize |
| `DURATION_PATTERN` | The duration grammar regex every duration field is checked against (P-9) |
| `isValidDuration(value)` | True when `value` matches `DURATION_PATTERN` |
| `parseDurationMs(value)` | Parse a duration string (`"30s"`, `"5m"`, …) → milliseconds |

### Environment, storage, and host capabilities

| Function | Description |
|----------|-------------|
| `unsuppliedRequiredEnv(component, suppliedKeys)` | List the component's `required:` variables that no value source in the file actually supplies |
| `indexOperatorStoragePaths(launch, suppliedPaths)` | Index operator-supplied storage paths against the launch's `content: operator` volumes (D-50), for per-volume lookup |
| `UnboundOperatorStorageError` | Thrown when a `content: operator` volume has no supplied path (D-50 row 2) |
| `MissingOperatorStoragePathError` | Thrown when an operator-supplied storage path does not exist or is not readable on the host (D-50 row 3); the directory is never created |
| `collectHostCapabilities(launch)` | Collect the app's requested host capabilities (D-44) as `"name=value (required\|optional)"` strings |
| `collectOperatorStorage(launch)` | Collect the volumes marked `content: operator` (D-50) as `"component.volume"` strings |
| `RESOURCE_PROPERTY_VOCABULARY` | Standard resource property vocabulary by resource type (SPEC.md § Resource Property Vocabulary, D-46) |

### Source mode

| Function | Description |
|----------|-------------|
| `resolveSourceRunCommand(component)` | Resolve which command runs a source-mode component: `commands.dev` wins, then `commands.start` — but `image` (no `dev`) returns `undefined` rather than falling back to `start` |
| `resolveSourcePrepareCommand(component)` | Resolve which command prepares a source-mode component (`commands.install` → `commands.build`) |

### Deployment state

A pure event-sourced state model — fold `LaunchEvent`s into a `DeploymentState`,
diff two states back into events, and resolve `$`-references against a state.

| Function | Description |
|----------|-------------|
| `reduce(state, event, at?)` | Fold one `LaunchEvent` into `DeploymentState` → the next state |
| `diff(prev, next)` | Compare two `DeploymentState`s → the `LaunchEvent`s that would fold `prev` into `next` |
| `resolveRef(state, ref, vantage)` | Resolve a `$`-reference against a `DeploymentState` → string (never throws on an unresolved reference) |

### Toolchain detection

| Function | Description |
|----------|-------------|
| `extractToolchainVersions(repoDir)` | Discover per-language toolchain versions declared in a repo checkout (`package.json`, `.tool-versions`, …) → `Promise<ToolchainVersions>` |

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
