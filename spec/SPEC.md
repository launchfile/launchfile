# Launchfile Specification

## Overview

A `Launchfile` is a declarative app descriptor that tells a deployment platform everything it needs to clone, build, wire, and run an application. A single file describes the runtime, network endpoints, resource dependencies, environment variables, lifecycle commands, and health checks. It supports both single-component apps (fields at the top level) and multi-component apps (via a `components` map).

```mermaid
graph LR
    A["📄 Launchfile"] --> B["Parse YAML"]
    B --> C["Validate Schema"]
    C --> D["Normalize Shorthands"]
    D --> E["Resolve Expressions"]
    E --> F["Provision & Deploy"]
```

## Quick Start

**Minimal** -- three fields plus a start command:

```yaml
version: launch/v1
name: my-api
runtime: node
commands:
  start: "node server.js"
```

Save this as a file named `Launchfile` in your project root. Validate it with the CLI:

```bash
npx launchfile validate
```

Three fields and a start command — that's a complete app descriptor.

**Single component** with a database and health check:

```yaml
version: launch/v1
name: my-app
runtime: node
requires: [postgres]
commands:
  start: "node server.js"
health: /health
```

The `requires` shorthand declares a Postgres dependency. You don't configure Postgres yourself — a Launchfile-compatible provider provisions it and wires the connection details into your environment. The `health: /health` shorthand tells the provider how to verify your app is ready.

**Multi-component** app:

```yaml
version: launch/v1
name: hedgedoc

components:
  backend:
    runtime: node
    provides:
      - protocol: http
        port: 3000
    requires:
      - type: postgres
        set_env:
          DATABASE_URL: $url
    commands:
      start: "node dist/main.js"

  frontend:
    runtime: node
    depends_on:
      - component: backend
        condition: healthy
    provides:
      - protocol: http
        port: 3001
        exposed: true
```

The `depends_on` field ensures `frontend` waits for `backend` to become healthy before starting. The expression `$components.backend.url` automatically resolves to the backend's URL at deploy time — no hardcoded ports or hostnames.

### Next Steps

- Read the [Top-Level Fields](#top-level-fields) reference for all available fields
- Browse [real-world examples](https://launchfile.dev/examples/) with annotated breakdowns
- Explore the [app catalog](https://launchfile.io/apps/) — community Launchfiles for popular apps
- Install the SDK: `npm install launchfile` — [setup guide](https://launchfile.dev/installation/)

## Top-Level Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | `string` | no | Spec version, e.g. `launch/v1` |
| `generator` | `string` | no | Tool that produced this file |
| `name` | `string` | **yes** | App name (lowercase kebab-case, `^[a-z][a-z0-9-]*$`) |
| `description` | `string` | no | Brief human description |
| `repository` | `string` | no | Source code URL (e.g. GitHub) |
| `website` | `string` | no | Project homepage URL |
| `logo` | `string` | no | Logo image URL |
| `keywords` | `string[]` | no | Discovery tags (e.g. `[blog, cms]`) |
| `secrets` | `map<string, Secret>` | no | App-wide generated secrets |
| `components` | `map<string, Component>` | no | Named components (multi-component mode) |

When `components` is absent, all component-level fields (`runtime`, `provides`, `requires`, `env`, `commands`, etc.) are read from the top level as a single implicit component.

When `components` is present, top-level component fields serve as **defaults** inherited by each component. Inheritance is shallow and field-level: if a component defines a field, its value replaces the top-level value entirely. Arrays and objects are never deep-merged — a component's `requires` replaces the top-level `requires`, it does not append to it.

> **YAML anchor warning:** YAML anchors (`&name` / `*name`) resolve to **deep copies** at parse time — they are not references. If an anchored block contains a `generator: secret` definition, each alias produces a separate generated value. Use `$secrets.<name>` for values that must be shared across components.

## Components

**Single-component mode:** place component fields directly at the top level (see Quick Start minimal example).

**Multi-component mode:** use the `components` map where each key is a component name (see Quick Start multi-component example).

Each component supports: `runtime`, `image`, `build`, `provides`, `requires`, `supports`, `env`, `commands`, `outputs`, `health`, `depends_on`, `storage`, `restart`, `schedule`, `singleton`, `platform`, `host`.

```mermaid
graph TD
    subgraph "HedgeDoc Launchfile"
        FE["frontend<br/>:3001 exposed"] -->|"depends_on: healthy"| BE["backend<br/>:3000 internal"]
        BE -->|"requires"| PG[("PostgreSQL")]
        FE -.->|"$components.backend.url"| BE
    end
```

> **Real-world examples:** [Chatwoot](https://launchfile.io/apps/chatwoot/) and [Dify](https://launchfile.io/apps/dify/) use multi-component Launchfiles with workers and frontends. [Browse all apps →](https://launchfile.io/apps/)

## Provides

Declares what network endpoints a component exposes. Value is an array of objects.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | no | -- | Endpoint name for cross-references (e.g. `api`, `metrics`) |
| `protocol` | `enum` | **yes** | -- | `http`, `https`, `tcp`, `udp`, `grpc`, `ws` |
| `port` | `integer` | **yes** | -- | Container port (1-65535) |
| `bind` | `string` | no | `0.0.0.0` | Bind address |
| `exposed` | `boolean` | no | `false` | Whether the port is reachable from outside the host. Most components in a multi-component app are internal services — only frontends and API gateways typically need `exposed: true`. |
| `spec` | `map<string, string>` | no | -- | API spec references (e.g. `openapi: file:docs/openapi.yaml`) |

```yaml
provides:
  - name: api
    protocol: http
    port: 3000
    exposed: true
    spec:
      openapi: file:docs/openapi.yaml
```

## Requires

Declares required resource dependencies. The app will not start without them. Value is an array; each entry is a **string** (shorthand) or an **object**.

A string shorthand (`requires: [postgres]`) expands to `[{ type: "postgres" }]`.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | no | Resource name for expression references (defaults to `type`) |
| `type` | `string` | **yes** | Resource type (see [Resource Property Vocabulary](#resource-property-vocabulary)) |
| `version` | `string` | no | Version constraint using semver ranges (e.g. `>=15`, `^7.0`, `20.x`) |
| `config` | `map<string, any>` | no | Resource provisioning hints (platform-interpreted) |
| `set_env` | `map<string, string>` | no | Maps resource properties to app env vars using `$` expressions |

```yaml
requires:
  - type: postgres
    version: ">=15"
    set_env:
      DATABASE_URL: $url
      DB_HOST: $host
      DB_PASSWORD: $password
```

### Resource naming

By default, a resource's name is its `type`. Expression references like `$postgres.host` use this name. When an app requires multiple instances of the same type, use the `name` field to distinguish them:

```yaml
requires:
  - type: postgres
    name: primary-db
    set_env:
      PRIMARY_DB_URL: $url
  - type: postgres
    name: analytics-db
    set_env:
      ANALYTICS_DB_URL: $url
```

References use the name: `$primary-db.host`, `$analytics-db.host`. Without `name`, two resources of the same type would be ambiguous.

### Version constraints

The `version` field uses semver range syntax (as defined by [node-semver](https://github.com/npm/node-semver)):

| Syntax | Meaning |
|---|---|
| `>=15` | Version 15 or higher |
| `^7.0` | Compatible with 7.x (>=7.0.0, <8.0.0) |
| `~2.1.0` | Approximately 2.1.x (>=2.1.0, <2.2.0) |
| `20.x` | Any 20.x version |
| `15.2.0` | Exact version |

### Resource configuration

The `config` map passes provisioning hints to the platform. Keys and semantics are resource-type-specific:

```yaml
requires:
  - type: postgres
    version: ">=15"
    config:
      extensions: [pgvector, postgis]
      shared_buffers: 256MB
  - type: redis
    config:
      maxmemory: 256mb
      maxmemory-policy: allkeys-lru
```

The platform interprets these hints when provisioning the resource. Unknown keys are ignored by platforms that don't support them.

### Expression wiring

Values in `set_env` use the [expression syntax](#expression-syntax). Inside a `requires` or `supports` block, bare `$prop` references resolve against the enclosing resource's property vocabulary.

> **Real-world examples:** See how [Ghost](https://launchfile.io/apps/ghost/), [Metabase](https://launchfile.io/apps/metabase/), and [Miniflux](https://launchfile.io/apps/miniflux/) declare their database requirements. [Browse all apps →](https://launchfile.io/apps/)

## Supports

Declares optional resources that enhance the app when available. Same schema as `requires`. Env vars from `set_env` are only injected when the resource is actually provisioned.

```yaml
supports:
  - type: redis
    set_env:
      CACHE_URL: $url
      USE_CACHE: "1"
```

The literal `"1"` is injected alongside the dynamic `$url` -- `set_env` values without `$` are passed through verbatim.

The expected app-side pattern: the app checks for the env var at startup and enables the feature if present. In this example, the app checks `CACHE_URL` — if it's set, caching is enabled; if Redis wasn't provisioned, the variable is simply absent and the app runs without caching. No conditional logic in the Launchfile.

## Secrets

Top-level `secrets` block defines app-wide generated values shared across components via `$secrets.<name>`.

| Field | Type | Required | Description |
|---|---|---|---|
| `generator` | `enum` | **yes** | Generation strategy (see below) |
| `description` | `string` | no | Human description |

Generator strategies:

| Generator | Produces | Example |
|---|---|---|
| `secret` | Cryptographically random hex string (suitable for signing keys, tokens). Use `\|base64` pipe for base64 encoding. | `a3f8b2c1d9e7...` |
| `uuid` | UUID v4 | `550e8400-e29b-41d4-a716-446655440000` |
| `port` | Allocates an available port on the host | `8432` |

```yaml
secrets:
  secret-key-base:
    generator: secret
  jwt-secret:
    generator: uuid
    description: "JWT signing key"

components:
  api:
    env:
      SECRET_KEY_BASE: "$secrets.secret-key-base"
  worker:
    env:
      SECRET_KEY_BASE: "$secrets.secret-key-base"
```

Both components receive the same generated value.

### Pipe transforms

Any resolved value can be piped through encoding transforms using the `|` operator, following the same convention as Unix pipes, Jinja2 filters, and Helm template pipelines:

| Expression | Output | Notes |
|---|---|---|
| `$secrets.key` | `a3f8b2c1d9e7...` | Default (hex) |
| `$secrets.key\|hex` | `a3f8b2c1d9e7...` | Explicit hex, same as default |
| `$secrets.key\|base64` | `o/iywd6X...` | Base64-encoded (standard, with padding) |
| `$host\|base64` | `ZGIuZXhhbXBsZS5jb20=` | Works on any reference, not just secrets |

Transforms compose with string interpolation for literal prefixes:

```yaml
secrets:
  app-key:
    generator: secret

env:
  # Raw hex (default)
  SESSION_SECRET: "$secrets.app-key"
  # Base64 with Laravel's required prefix
  APP_KEY: "base64:${secrets.app-key|base64}"
```

The `|` is unambiguous — dots navigate paths, pipes apply transforms. This distinction matters for future extensibility (e.g., key pair properties like `$secrets.key.private` are navigation, not transforms).

Currently defined transforms: `base64`, `hex`. The pipeline is extensible — future spec versions may add transforms like `urlsafe` or `sha256`.

**`base64` encoding behavior:** When the input is a hex string (even-length, all hex characters — as produced by `generator: secret`), `|base64` decodes the hex to raw bytes first, then base64-encodes the bytes. For non-hex inputs, `|base64` encodes the raw string directly. This means `$secrets.key|base64` produces compact base64 from the secret's underlying bytes, not a base64 encoding of the hex *text*.

## Environment Variables

The `env` map declares app-owned environment variables. Each value is a **string** (shorthand for default value) or an **object**.

| Field | Type | Required | Description |
|---|---|---|---|
| `default` | `string \| number \| boolean` | no | Default value |
| `description` | `string` | no | Human description (supports markdown) |
| `label` | `string` | no | Short label for CLI prompts |
| `required` | `boolean` | no | App cannot start without this value |
| `example` | `string` | no | Example value showing expected format |
| `generator` | `enum` | no | Auto-generate: `secret`, `uuid`, `port` |
| `sensitive` | `boolean` | no | Store in a secrets manager |

A bare scalar (`PORT: "8080"`) is shorthand for `{ default: "8080" }`. Booleans and numbers work too.

When `generator: secret` is set, `sensitive: true` is implied — the platform should store the generated value in a secrets manager and mask it in logs and UI.

```yaml
env:
  PORT:
    default: "8080"
  API_KEY:
    required: true
    description: "Third-party API key"
    example: "sk-live-abc123..."
  SESSION_SECRET:
    generator: secret
    sensitive: true
```

> **Real-world examples:** See how [WordPress](https://launchfile.io/apps/wordpress/) and [Gitea](https://launchfile.io/apps/gitea/) wire environment variables from resources. [Browse all apps →](https://launchfile.io/apps/)

## Commands

Lifecycle commands for build, release, and run stages. Each value is a **string** (shorthand) or an **object** with `command` and optional `timeout`.

Platforms execute well-known commands in this order: **build → release → start**. The `seed` and `test` commands are invoked on demand, not as part of the standard deploy lifecycle.

| Stage | Purpose | When |
|---|---|---|
| `build` | Install dependencies, compile | Every deploy |
| `release` | Migrations, cache clear, asset compilation | Every deploy, after build |
| `start` | Start the application | Every deploy, after release |
| `seed` | Seed the database with initial data | On demand (first deploy or explicit trigger) |
| `test` | Run the test suite | On demand (CI or explicit trigger) |

Additional named commands are allowed and invoked on demand.

```yaml
commands:
  build: "npm install"
  release: "npx prisma migrate deploy"
  start: "node server.js"
  test: "npm test"
```

**With timeout:**

```yaml
commands:
  release:
    command: "npx prisma migrate deploy"
    timeout: "5m"
```

## Outputs

Named outputs capture values printed to stdout during the `release` command. The platform matches each output's regex pattern against the command's stdout and stores the first capture group's value.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `pattern` | `string` | **yes** | -- | Regex with one capture group, matched line-by-line against release command stdout |
| `description` | `string` | no | -- | Human-readable description of this output |
| `sensitive` | `boolean` | no | `false` | If `true`, value is masked in API/UI unless explicitly revealed |

This is useful for capturing generated credentials, URLs, or configuration that the setup process produces:

```yaml
commands:
  release: "./setup.sh"

outputs:
  admin_password:
    pattern: "Admin password: (.+)"
    description: "Generated admin password from initial setup"
    sensitive: true
  admin_url:
    pattern: "Dashboard: (https?://\\S+)"
    description: "URL to the admin dashboard"
```

Outputs are only captured during the `release` command. If the pattern does not match any line, the output is absent (not an error). Platforms should make captured outputs available through their API or UI.

## Health

Health check configuration. Value is a **string** (shorthand for HTTP path) or an **object**.

A string shorthand (`health: /health`) expands to `{ path: "/health" }`.

| Field | Type | Description |
|---|---|---|
| `path` | `string` | HTTP path to check |
| `command` | `string` | Shell command for non-HTTP checks |
| `interval` | `string` | Check interval (e.g. `30s`, `1m`) |
| `timeout` | `string` | Timeout per check attempt |
| `retries` | `integer` | Consecutive failures before unhealthy (min: 1) |
| `start_period` | `string` | Grace period before failures count |

Use `path` for HTTP checks or `command` for exec checks. If both are present, `path` takes precedence.

```yaml
health:
  path: /api/private/config
  start_period: 30s
  retries: 3
```

> **Real-world examples:** See health check patterns in [Metabase](https://launchfile.io/apps/metabase/) (custom path + timing) and [Ghost](https://launchfile.io/apps/ghost/) (simple path). [Browse all apps →](https://launchfile.io/apps/)

## Build

Build configuration. A string shorthand (`build: "."`) expands to `{ context: "." }`.

| Field | Type | Description |
|---|---|---|
| `context` | `string` | Build context directory (relative to repo root) |
| `dockerfile` | `string` | Path to Dockerfile |
| `target` | `string` | Multi-stage build target |
| `args` | `map<string, string>` | Build arguments |
| `secrets` | `string[]` | Secret names available during build (never baked into image) |

Each entry in `secrets` is a name that the platform resolves at build time. The name may reference a top-level `secrets:` entry (generated by the Launchfile) or a platform-managed secret (e.g., an NPM token or SSH key provided out-of-band). The platform mounts each secret during the build phase and ensures it is never included in the resulting image.

```yaml
secrets:
  npm-token:
    generator: secret

build:
  dockerfile: ./docker/Dockerfile.backend
  target: production
  args:
    NODE_ENV: production
  secrets:
    - npm-token          # from top-level secrets block
    - ssh-deploy-key     # platform-managed, provided out-of-band
```

## Storage

Declares persistent volumes. Value is a map of named volumes.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | **yes** | -- | Mount path inside the container |
| `size` | `string` | no | -- | Minimum size hint (e.g. `512MB`, `10GB`) |
| `persistent` | `boolean` | no | `true` | Whether data survives restarts |

If you're declaring named storage, you probably want it to survive restarts — hence the default. Use `persistent: false` explicitly for ephemeral scratch space like caches.

```yaml
storage:
  uploads:
    path: /app/uploads
    size: 10GB
  cache:
    path: /app/cache
    size: 512MB
    persistent: false
```

> **Real-world examples:** [Ghost](https://launchfile.io/apps/ghost/) and [Paperless](https://launchfile.io/apps/paperless/) use persistent storage for content. [Browse all apps →](https://launchfile.io/apps/)

## Depends On

Startup ordering between components. A string shorthand (`depends_on: [backend]`) expands to `[{ component: "backend" }]`.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `component` | `string` | **yes** | -- | Component name |
| `condition` | `enum` | no | `started` | `started` or `healthy` |

```yaml
depends_on:
  - component: backend
    condition: healthy
```

## Host

Declares host-level capabilities the app requires that cannot be satisfied inside a standard container. When a deployer cannot meet these constraints, it should refuse the deployment with a clear error message rather than failing at runtime.

| Field | Type | Description |
|---|---|---|
| `docker` | `enum` | `required` -- needs Docker daemon access on the host (not Docker-in-Docker). `optional` -- enhanced when available. |
| `network` | `enum` | `host` -- must share the host network stack. `bridge` (default) -- standard container networking. |
| `filesystem` | `enum` | `read-write` -- needs persistent host filesystem access. `read-only` -- only reads from host. `none` (default) -- no host filesystem needed. |
| `privileged` | `boolean` | Requires elevated privileges (e.g. device access). Default `false`. |

```yaml
# App that orchestrates Docker containers on the host
host:
  docker: required
  network: host
  filesystem: read-write
```

When `host.docker` is `required`, the deployer must ensure the app runs with access to the Docker daemon socket (e.g. `/var/run/docker.sock`). If the deployer's execution strategy is container-based, it should either refuse or warn that Docker-in-Docker is unreliable.

## Runtime, Image, and Build

These three fields describe what the app needs to run and how to package it. They serve different purposes and can coexist.

### `runtime`

Runtime identifier declaring what language or platform the app needs. Platforms MAY use this to select a base image or buildpack.

Valid values: `node`, `bun`, `deno`, `python`, `ruby`, `go`, `rust`, `java`, `php`, `elixir`, `csharp`, `static`.

```yaml
runtime: node
```

The `runtime` field is metadata — it describes the app, not the infrastructure. Changing the deployment target (Docker → Kubernetes → bare metal) does not change the runtime value.

The `runtime` field does not include a version. Platforms and AI analyzers should discover the version from ecosystem-standard files already in the repo: `.nvmrc`, `.node-version`, `.tool-versions`, `package.json` `engines`, `.python-version`, `.ruby-version`, `Gemfile`, `go.mod`, etc. This avoids duplicating version information that already has a canonical source.

### `image`

A pre-built OCI container image reference. When `image` is present, the platform pulls this image instead of building from source.

```yaml
image: ghcr.io/hedgedoc/hedgedoc:1.9.9
```

### Relationship between the three

| Combination | Meaning |
|---|---|
| `runtime` only | Platform selects a buildpack or base image |
| `build` only | Build from source; platform infers runtime from Dockerfile |
| `image` only | Use pre-built image; no build step |
| `runtime` + `build` | Build from source; `runtime` is metadata |
| `runtime` + `image` | Use pre-built image; `runtime` is metadata |
| `build` + `image` | Build from source; `image` is the name/tag for the resulting artifact |

Think of it like Docker Compose: `build` is how you create the image, `image` is the name/tag of the resulting artifact. When only `image` is provided, there's nothing to build — the platform pulls it directly.
| All three | Build from source, tag as `image`, `runtime` is metadata |

## Other Fields

| Field | Type | Description |
|---|---|---|
| `restart` | `enum` | Restart policy: `always` (restart unconditionally), `on-failure` (restart only on non-zero exit), `no` (never restart) |
| `schedule` | `string` | Cron expression for scheduled jobs |
| `singleton` | `boolean` | When `true`, the platform must not run more than one instance of this component |
| `platform` | `string \| string[]` | OCI platform constraint (e.g. `linux/amd64`, `linux/arm64`) |
| `host` | `object` | Host-level constraints (see [Host](#host)) |

### `schedule`

Standard 5-field cron format: `minute hour day-of-month month day-of-week`.

```yaml
schedule: "0 0 * * *"    # daily at midnight
schedule: "*/15 * * * *"  # every 15 minutes
```

Platforms MAY additionally support a 6-field format with seconds (`second minute hour dom month dow`) and shortcut aliases (`@daily`, `@hourly`, `@weekly`). Files targeting broad compatibility should use the 5-field format.

### `platform`

Follows the OCI image platform specification: `os/architecture[/variant]`. Accepts a single string or an array for multi-platform support.

```yaml
# Single platform
platform: linux/amd64

# Multiple platforms
platform:
  - linux/amd64
  - linux/arm64
```

Common values: `linux/amd64`, `linux/arm64`, `linux/arm/v7` (Raspberry Pi 32-bit). The Launchfile targets containerized and server deployments; bare-metal microcontroller platforms (Arduino, ESP32) are outside its scope.

See `examples/cron-job.yaml` and `examples/prebuilt-image.yaml` for full examples.

## Value Patterns

Several fields accept a scalar shorthand that expands to an object:

| Field | Shorthand | Expands to |
|---|---|---|
| `requires[]` | `"postgres"` | `{ type: "postgres" }` |
| `supports[]` | `"redis"` | `{ type: "redis" }` |
| `env.VAR` | `"8080"` | `{ default: "8080" }` |
| `build` | `"."` | `{ context: "." }` |
| `health` | `"/health"` | `{ path: "/health" }` |
| `commands.start` | `"node app.js"` | `{ command: "node app.js" }` |
| `depends_on[]` | `"backend"` | `{ component: "backend" }` |

Booleans and numbers are also valid shorthand for `env` values (they become the `default`).

## Expression Syntax

The `$` reference system is used in `set_env` values and `env` defaults to wire dynamic values.

| Syntax | Meaning |
|---|---|
| `$prop` | Property from enclosing resource |
| `$resource.prop` | Property from a named resource |
| `$components.name.prop` | Property from another component's provides |
| `$components.name.endpoint.prop` | Property from a named endpoint on another component |
| `$secrets.name` | App-wide generated secret |
| `$app.prop` | Platform-injected app property (see [App Properties](#app-properties)) |
| `$ref\|transform` | Any reference piped through a transform (e.g. `\|base64`) |
| `${prop}` | Explicit braced form (same as `$prop`) |
| `${prop:-default}` | Reference with fallback value |
| `$$` | Literal `$` (escape) |

```mermaid
flowchart TD
    A["$reference in set_env"] --> B{"Reference type?"}
    B -->|"Single segment: $host"| C["Enclosing resource property"]
    B -->|"Dot path: $resource.prop"| D["Named resource lookup"]
    B -->|"components.*"| E["Component endpoint"]
    B -->|"secrets.*"| F["App-wide secret"]
    C --> G["Resolved value"]
    D --> G
    E --> G
    F --> G
```

**Resolution order** for a path:

1. Starts with `app` -- platform-injected app property (see [App Properties](#app-properties))
2. Starts with `secrets` -- app-wide secret lookup
3. Starts with `components` -- component endpoint lookup
4. Single segment -- enclosing resource property (e.g. `$url` inside a `set_env` block)
5. Multi-segment -- first segment is the resource name (defaults to `type`, overridden by `name`), rest is property path

The `app` namespace is reserved: it is checked before any other prefix and cannot be shadowed by a user-named resource. If a `requires:` entry is named `app`, expressions like `$app.url` still resolve via the App Properties table rather than against that resource — use a different `name:` for resources to avoid the reserved word.

**Examples:**

```yaml
set_env:
  DATABASE_URL: $url                                          # resource property
  JDBC_URL: "jdbc:postgresql://${host}:${port}/${name}"       # composed template
  DB_PORT: "${port:-5432}"                                    # with fallback

env:
  BACKEND_URL:
    default: $components.backend.url                          # cross-component
  METRICS_URL:
    default: $components.backend.metrics.url                  # named endpoint
  SECRET_KEY_BASE: "$secrets.secret-key-base"                 # app-wide secret
  HOME_BIN: "$$HOME/bin"                                      # literal $
  PUBLIC_URL: $app.url                                        # platform-injected app URL
```

## App Properties

The `$app.*` namespace exposes platform-injected properties of the deployed app itself. These are resolved at deploy time by whichever provider is running the app, so a Launchfile can reference its own public URL without hardcoding environment-specific values.

| Property | Description |
|---|---|
| `$app.url` | The app's public URL (e.g. `https://myapp.example.com`) |
| `$app.host` | The app's public hostname (e.g. `myapp.example.com`) |
| `$app.port` | The app's allocated public port number |
| `$app.name` | The app name as deployed |

The values are determined by the provider's routing strategy at deploy time. A Cloudflare Tunnel deployment might resolve `$app.url` to `https://myapp.example.com`; a local development provider might resolve it to `http://myapp.lvh.me:10001`; a Kubernetes deployment behind an Ingress might resolve it to `https://myapp.k8s.internal`. The Launchfile stays the same.

The standard set above is the portable vocabulary every provider must support. Providers MAY expose additional `$app.*` properties (e.g. `$app.region`, `$app.deployment_id`) as platform-specific extensions; portable Launchfiles should use only the standard set. Unknown `$app.*` properties resolve to empty string, matching the behavior of unknown resource properties (see [L-4](DESIGN.md#l-4-resource-property-vocabulary-is-implicit)).

`$app.url` differs from `$components.<this>.url` in two ways. First, it gives the *public* URL — the address external users reach the app on — not the internal component port. Second, it works in single-component mode where there is no component name to reference. Use `$app.url` for public-facing values (auth callback URLs, webhook registration, public-facing email links) and `$components.<name>.url` for internal cross-component wiring.

Similarly, `$app.port` is the allocated *external* port that the platform exposes; `provides[].port` is the *container* port the component binds inside its sandbox. They can differ — a component might bind `3000` while the platform exposes `10001`.

Example use:

```yaml
env:
  PUBLIC_URL: $app.url                # Drupal, BookStack, Mealie, Firefly III
  BETTER_AUTH_URL: $app.url           # better-auth callback base
  OAUTH_REDIRECT_URI: "${app.url}/oauth/callback"
  WEBHOOK_URL: "${app.url}/webhooks/incoming"
```

## Resource Property Vocabulary

Each resource type exposes well-known properties for use in `set_env` expressions:

| Resource | Properties |
|---|---|
| `postgres` | `url`, `host`, `port`, `user`, `password`, `name` |
| `mysql` | `url`, `host`, `port`, `user`, `password`, `name` |
| `sqlite` | `url`, `path` |
| `mongodb` | `url`, `host`, `port`, `user`, `password`, `name` |
| `redis` | `url`, `host`, `port`, `password` |
| `memcache` | `url`, `host`, `port` |
| `rabbitmq` | `url`, `host`, `port`, `user`, `password` |
| `elasticsearch` | `url`, `host`, `port` |
| `minio` | `url`, `host`, `port`, `access_key`, `secret_key`, `bucket` |
| `clickhouse` | `url`, `host`, `port`, `user`, `password`, `name` |
| `kafka` | `url`, `host`, `port` |
| `s3` | `url`, `access_key`, `secret_key`, `bucket`, `region` |

The `url` property is always a fully-formed connection string (e.g. `postgresql://user:pass@host:5432/dbname`). Other properties provide individual components for apps that require them separately.

Resource types are extensible -- any string is accepted. Unknown types have no predefined property vocabulary; their properties are platform-defined.

## YAML Compatibility

A Launchfile is standard YAML 1.2. All YAML features work, and no custom tags are used. See [DESIGN.md D-22](DESIGN.md#d-22-yaml-as-the-file-format) for why YAML was chosen.

### Arrays don't need extra indentation

The `-` can sit at the same column as the key. Both forms are valid:

```yaml
# Indented (common style)
requires:
  - postgres
  - redis

# Flush (equally valid, more compact)
requires:
- postgres
- redis

# Inline (shortest)
requires: [postgres, redis]
```

### Anchors, aliases, and merge keys

Use `&name` to define a reusable block, `*name` to reference it, and `<<:` to merge it into a map:

```yaml
x-shared: &shared
  runtime: node
  build: .
  health: /health
  env:
    LOG_LEVEL: "info"

components:
  api:
    <<: *shared
    commands:
      start: "node api.js"
    provides:
      - protocol: http
        port: 3000

  worker:
    <<: *shared
    commands:
      start: "node worker.js"
    env:
      LOG_LEVEL: "debug"  # overrides the shared value
```

The `x-` prefix is a convention for extension fields that parsers ignore. Merged values can be overridden by declaring the same key after the merge.

> **Copy semantics:** YAML aliases (`*name`) are resolved to deep copies by the parser — they are not live references. If an anchored block contains a `generator: secret` definition, each alias produces a **separate** generated value. For values that must be shared across components, use the `$secrets.<name>` expression system instead of YAML anchors.

### Block scalars for multi-line text

Use `|` (literal) to preserve newlines, or `>` (folded) to join lines:

```yaml
commands:
  release: |
    npx prisma migrate deploy
    npx prisma db seed
    echo "Release complete"

description: >
  A multi-component web application with
  a REST API, background workers, and
  a static frontend.
```

### JSON is valid YAML

Any YAML 1.2 parser accepts JSON. If you prefer braces and quotes:

```json
{
  "name": "my-app",
  "runtime": "node",
  "requires": ["postgres", "redis"],
  "commands": { "start": "node server.js" },
  "health": "/healthz"
}
```

This parses identically to the YAML equivalent. You can also mix styles — JSON inline for short values, YAML block for complex structures.

## Security Considerations

Launchfile is a trust boundary — like a Dockerfile or Makefile, it declares what should run. Providers that execute Launchfiles should be aware of these security properties:

### Config values are untrusted input

The `config` field in `requires`/`supports` entries accepts arbitrary key-value pairs (`Record<string, unknown>`). Providers **MUST** validate and sanitize config values before using them in shell commands, SQL queries, API calls, or any other injectable context. For example, a postgres provider should validate that extension names match `^[a-zA-Z_][a-zA-Z0-9_]*$` before passing them to `CREATE EXTENSION`.

### Commands and health checks are executable

`commands.start`, `commands.build`, `commands.release`, and `health.command` contain shell commands that the provider executes. This is by design — the user chose to run this Launchfile. Providers that fetch Launchfiles from remote sources (catalogs, URLs) should display what will be executed and prompt for confirmation before running.

### Host capabilities require user consent

`host.privileged`, `host.docker`, and `host.filesystem` declare elevated capabilities. Providers should either refuse or require explicit user confirmation before granting these.

### Secrets and state

Generated secrets (from `generator: secret|uuid`) and connection credentials should be stored with restrictive file permissions (e.g., 0600) and excluded from version control.

## Extensibility

The format is designed for additive evolution:

- New fields can be added at any level without breaking existing files
- Unknown fields are ignored by parsers that do not support them
- No custom YAML tags (`!tag`) are used or required
- The `version` field enables future breaking changes via versioned schemas
