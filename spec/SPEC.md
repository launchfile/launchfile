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

**Bare minimum** — the schema requires only `name`. In practice you also need a runtime and a start command for the platform to actually run your app:

```yaml
name: my-api
runtime: node
commands:
  start: "node server.js"
```

Save this as a file named `Launchfile` in your project root. Validate it with the CLI:

```bash
npx launchfile validate
```

**Recommended minimal** — declare the spec version explicitly so tooling knows which schema to validate against. `version` defaults to `launch/v1` when absent, but stating it is best practice:

```yaml
version: launch/v1
name: my-api
runtime: node
commands:
  start: "node server.js"
```

**Local development** — no container, no provisioning. Install deps and start a dev server:

```yaml
name: my-app
runtime: bun
commands:
  build: "bun install"
  start: "bun run dev"
```

`launchfile up .` runs `build` then `start`. Swap the commands for any runtime — `runtime: node` with `npm install` / `npm run dev`, `runtime: python` with `pip install -r requirements.txt` / `python manage.py runserver`, etc. See [`spec/examples/local-dev.yaml`](examples/local-dev.yaml). To run a *different* command from source than from the built artifact, declare a [`dev` command](#source-mode-commands).

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
| `repository` | `string` | no | Canonical source origin URL (e.g. GitHub) — see [Repository](#repository) |
| `website` | `string` | no | Project homepage URL |
| `logo` | `string` | no | Logo image URL |
| `keywords` | `string[]` | no | Discovery tags (e.g. `[blog, cms]`) |
| `secrets` | `map<string, Secret>` | no | App-wide generated secrets |
| `components` | `map<string, Component>` | no | Named components (multi-component mode) |
| `runtime` | `enum` | no | Language/platform identifier — see [Runtime](#runtime) |
| `image` | `string` | no | Pre-built OCI image reference — see [Image](#image) |
| `build` | `object \| string` | no | Build configuration — see [Build](#build) |

When `components` is absent, all component-level fields ([`runtime`](#runtime), [`image`](#image), [`build`](#build), [`provides`](#provides), [`requires`](#requires), [`env`](#environment-variables), [`commands`](#commands), etc.) are read from the top level as a single implicit component.

When `components` is present, top-level component fields serve as **defaults** inherited by each component. Inheritance is shallow and field-level: if a component defines a field, its value replaces the top-level value entirely. Arrays and objects are never deep-merged — a component's `requires` replaces the top-level `requires`, it does not append to it.

> **YAML anchor warning:** YAML anchors (`&name` / `*name`) resolve to **deep copies** at parse time — they are not references. If an anchored block contains a `generator: secret` definition, each alias produces a separate generated value. Use `$secrets.<name>` for values that must be shared across components.

## Components

**Single-component mode:** place component fields directly at the top level (see Quick Start minimal example).

**Multi-component mode:** use the `components` map where each key is a component name (see Quick Start multi-component example).

Each component supports: [`runtime`](#runtime), [`image`](#image), [`build`](#build), [`provides`](#provides), [`requires`](#requires), [`supports`](#supports), [`env`](#environment-variables), [`commands`](#commands), [`health`](#health), [`depends_on`](#depends-on), [`storage`](#storage), [`restart`](#other-fields), [`schedule`](#other-fields), [`singleton`](#other-fields), [`platform`](#other-fields), [`host`](#host) *(deprecated — see [Host](#host))*. Named outputs captured from a command's stdout are declared via the `capture:` field inside an expanded command form — see [Command Capture](#command-capture).

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
| `tls` | `string` or `object` | no | -- | Names one `supports:` entry of type `certificate` on the same component: the certificate this listener serves when native TLS is selected. See [Native TLS](#native-tls-with-a-certificate-binding). |

Each `provides` entry's `protocol` describes what that component's own listener
speaks on that entry's `port`, in the configuration this Launchfile describes. It
never describes a public endpoint's scheme. A provider may publish an `https://`
URL while forwarding cleartext HTTP to a component declaring `protocol: http`;
that is not a mismatch and no tool may report it as one. The app's primary public
scheme is `$app.scheme`, derived from `$app.url`; every other published endpoint's
public address is `$app.endpoints.<name>.*`, reachable by the entry's `name:`
([Per-endpoint properties](#per-endpoint-properties), [D-63](DESIGN.md#d-63-appendpointsname--per-endpoint-publication-context)) — a
supplied publication context still asserts the primary's address only
([D-58](DESIGN.md#d-58-orchestrator-supplied-publication-context--app-under-an-owning-orchestrator) rule 4). Declaring one listener configuration
says nothing about the other configurations an app supports — a consumer MUST NOT
infer from `protocol: http` that a component cannot be configured to serve TLS.

```yaml
provides:
  - name: api
    protocol: http
    port: 3000
    exposed: true
    spec:
      openapi: file:docs/openapi.yaml
```

### Native TLS with a certificate binding

Some apps terminate TLS on their own listener when they are given a certificate. `tls:` says so, by naming one `supports:` entry of type `certificate` on the same component ([D-61](DESIGN.md#d-61-an-active-certificate-binding-selects-a-provides-entrys-effective-listener)):

```yaml
provides:
  - name: web
    protocol: http       # the baseline listener (D-59)
    port: 3000
    exposed: true
    tls: server-cert     # shorthand for `tls: { certificate: server-cert }`
supports:
  - name: server-cert
    type: certificate
    set_env:
      GITEA__server__PROTOCOL: https
      GITEA__server__HTTP_PORT: "3000"
      GITEA__server__CERT_FILE: $cert_file
      GITEA__server__KEY_FILE: $key_file
env:
  GITEA__server__PROTOCOL: http
```

*"I serve HTTP on 3000. I can serve HTTPS on that same listener with this certificate; here is the wiring."*

**Declared and effective.** Every `provides` entry has a **declared** protocol and port — the fields in the file — and an **effective** protocol and port, which is what the listener speaks in the configuration the deployment selected. They are equal unless a bound certificate is **active**; then the effective protocol is `https` and the effective port is the declared `port:`. Validation, tooling and the audit surface read the declared value; every URL-emitting expression derived from a listener (`$components.<name>.url`, and `$app.url` where the provider computes it from its own publication of that listener) reads the effective one. An orchestrator-supplied publication context still wins ([PROVIDERS.md](PROVIDERS.md) §7).

Five rules bind the binding:

1. **It binds one entry, by identity.** The named entry must exist in the same component's `supports:` and declare `type: certificate`. A certificate named by two `provides` entries is a **validation error**, active or not. Naming a `requires:` entry is a validation error too: required native TLS is out of scope here. The bound entry must speak an HTTP-family protocol — `http`, `https`, `ws` or `grpc` — because an active binding makes its effective protocol `https`; `tls:` on a `tcp` or `udp` entry is a validation error naming the entry, the same family line an [`https-origin`](#public-https-origins) `endpoint:` draws.
2. **Availability is not activation.** A certificate being available does not turn the binding on — the consumer selects native TLS, outside the file, the same way any other optional resource is selected ([D-8](DESIGN.md#d-8-supports-with-set_env-for-optional-capabilities)).
3. **Active `set_env` beats `env:`.** With the binding active the app receives `GITEA__server__PROTOCOL: https` from `set_env`, not the `http` its `env:` declares; inactive, the `env:` value applies unchanged and the binding's keys are absent. This holds for every `set_env` binding, not only certificates — see [PROVIDERS.md](PROVIDERS.md) §7.
4. **It composes with `https-origin`, and implies nothing about it.** A certificate binding does not by itself satisfy an [`https-origin`](#public-https-origins) entry, and an `https-origin` entry does not imply a certificate. An app may declare both, either, or neither.
5. **Delivery, then refuse or run the baseline.** `cert_file` and `key_file` arrive through the provider's supplied-resource channel ([D-56](DESIGN.md#d-56-orchestrator-satisfied-requiressupports--the-supplied-resource-channel)) and the provider does not verify them. Selected but missing either one, or selected on a provider that cannot activate native TLS, **fails before launch naming the entry** — never a silent fall back to HTTP. Not selected, the component runs its declared HTTP baseline.

A reader that ignores `tls:` and the `certificate` entry launches the declared baseline, which is correct rather than degraded: nobody selected the capability.

## Requires

Declares required resource dependencies. The app will not start without them. Value is an array; each entry is a **string** (shorthand) or an **object**.

A string shorthand (`requires: [postgres]`) expands to `[{ type: "postgres" }]`.

An object entry is one of two kinds, distinguished by its marker field: a **backing service** (has `type:`) that the provider provisions and wires, or a **host capability** (has `host:`) that the provider grants or refuses — see [Host capabilities](#host-capabilities).

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | no | Resource name for expression references (defaults to `type`) |
| `type` | `string` | **yes** | Resource type (see [Resource Property Vocabulary](#resource-property-vocabulary)) |
| `endpoint` | `string` | conditional | The `provides` entry this resource fronts, by its `name`. **Required** on a `type: https-origin` entry; meaningless on any other type — see [Public HTTPS origins](#public-https-origins) |
| `version` | `string` | no | Version constraint using semver ranges (e.g. `>=15`, `^7.0`, `20.x`) |
| `config` | `map<string, any>` | no | Resource provisioning hints (platform-interpreted) |
| `uses` | `array<string \| object>` | no | Which features of the resource the app uses (e.g. `[db, pubsub]` for redis); a repeatable use may be named more than once (`- db: cache`) — see [Resource uses](#resource-uses) |
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

### Resource uses

`requires: redis` says the app needs Redis. It does not say what the app needs *of* it — one keyspace, pub/sub channels, or the whole server. `uses` states that fact. It is a list of tokens from a small per-type vocabulary ([Resource Use Vocabulary](#resource-use-vocabulary)):

```yaml
requires:
  - type: redis
    uses: [db, pubsub]
    set_env:
      CACHE_URL: $redis.db.url          # redis://host:6379/<index>
      CACHE_DB: $redis.db.index         # the integer
      REDIS_URL: $url                   # the instance, as before
```

**Undeclared means what the property vocabulary already promises.** A `requires: redis` entry with no `uses` is satisfied by any Redis the platform supplies that speaks the property vocabulary — pooled or dedicated — exactly as before; it does not mean a dedicated server. A `requires: postgres` entry with no `uses` is one database (`name`), also as before. An app that needs the whole server declares `uses: [server]`.

**Declared uses narrow the need and select the fields.** A platform may satisfy the entry from a shared unit only when every declared use fits in that unit; otherwise it provisions, or refuses. Each use registers its own properties, addressed as `$<resource>.<use>.<property>` — `$redis.db.url` is the standard Redis URL with the database selected by path (`redis://[user:password@]host:port/<index>`), `$redis.db.index` that integer. The entry-level `$url`, `$host`, `$port` and `$password` keep their meaning: the instance address. A use that registers no property of its own (`pubsub`, `server`) is addressed through the instance properties. Inside an entry that declares `uses`, a `$<resource>.<use>.<property>` path either resolves from the use's registered properties or is an **error** — never an empty string, never a fallback to the instance value — so a mistyped use fails at wiring time rather than connecting the app to the wrong database. That error stops generation for the whole app: the provider emits nothing, for any component. It does not skip the single component, which is what a provider does when it cannot cover a declared use ([D-64](DESIGN.md#d-64-a-requires-entry-a-provider-cannot-provision-is-refused--provision-accept-supplied-or-refuse-for-every-type)) — a reference to a use the entry never declared is wrong in the file, so no partly-wired deployment is produced.

**A provider covers every declared use or refuses the component.** A use the provider cannot cover — including a token it does not recognise, since no provider can claim to cover a use it does not know — takes the same refuse branch as a resource type it cannot provision ([PROVIDERS.md](PROVIDERS.md) §10 item 5, [D-64](DESIGN.md#d-64-a-requires-entry-a-provider-cannot-provision-is-refused--provision-accept-supplied-or-refuse-for-every-type)): the component is refused before launch, naming the entry and the uncovered use. The vocabulary is open, so a token outside the standard set is a `validate` warning rather than a validation error — but at deploy time a typo fails the deployment rather than being silently ignored. On a `supports:` entry the same shortfall leaves the entry unfulfilled with a warning, never refused.

**A repeatable use may be named more than once.** A use the vocabulary marks **repeatable** (`db` on redis, `database` on postgres and mysql) may appear more than once on one entry, each occurrence written as a single-key map naming it. The name is an expression path segment and takes the name grammar (`^[a-z][a-z0-9-]*$`):

```yaml
requires:
  - type: redis
    uses:
      - db: cache
      - db: sessions
      - pubsub
    set_env:
      CACHE_URL: $redis.db.cache.url        # redis://host:6379/<index of cache>
      SESSION_URL: $redis.db.sessions.url   # a different index
      SESSION_DB: $redis.db.sessions.index
      REDIS_URL: $url                       # the instance, as before
```

Each named use registers the token's properties under its name, addressed as `$<resource>.<use>.<name>.<property>` — the same nesting `$app.endpoints.<name>.<property>` uses: `$redis.db.cache.url` is `redis://[user:password@]host:port/<index>` with the index allocated to `cache`, `$redis.db.cache.index` that integer; `$postgres.database.<name>.url` is the standard URL with `/<database>` as its path and `$postgres.database.<name>.name` that database. A platform hands each named occurrence its own unit — one Redis database per named `db`, one database per named `database` — so two names never share one. The entry-level properties keep the instance meaning, and an unnamed single `db` keeps the three-segment `$redis.db.url` form: naming is for the entry that needs more than one.

Within one entry a token is declared **bare or named, never both** — `uses: [db, {db: cache}]` is invalid, because `$redis.db.url` and `$redis.db.cache.url` would then name two different databases under one token; name every occurrence, or declare the token once unnamed. The same name twice on one token is invalid, as a bare token twice is. A name on a use the vocabulary marks non-repeatable (`pubsub`, `server`) is a **validation error**, not a lint warning: the name would promise a second set of channels or a second server the type cannot hand over. A token outside the standard vocabulary may take a name — the vocabulary is open, and whether a provider-defined use repeats is that provider's to say.

The strict resolution rule above extends to the named form. On an entry that names its `db` uses, `$redis.db.url` — the bare form — is an error, not the instance URL and not any one of the named databases; `$redis.db.nosuch.url` names an occurrence the entry does not declare and is an error too. A provider covers each named occurrence or refuses the component, naming the entry, the token and the name; a supplied resource satisfies the entry only when its map carries every registered `<use>.<name>.<property>` key.

### Expression wiring

Values in `set_env` use the [expression syntax](#expression-syntax). Inside a `requires` or `supports` block, bare `$prop` references resolve against the enclosing resource's property vocabulary.

> **Real-world examples:** See how [Ghost](https://launchfile.io/apps/ghost/), [Metabase](https://launchfile.io/apps/metabase/), and [Miniflux](https://launchfile.io/apps/miniflux/) declare their database requirements. [Browse all apps →](https://launchfile.io/apps/)

### Public HTTPS origins

An app that only works over HTTPS says so with the backing-service type `https-origin`: *browsers reach this app at a public origin whose scheme is `https`*. Like any backing service, the provider **provisions and wires it, or refuses** — it is not a hint and not a probe.

```yaml
provides:
  - name: web
    protocol: http
    port: 80
    exposed: true
requires:
  - type: https-origin
    endpoint: web
    set_env:
      DOMAIN: $url
```

The app's own listener is untouched: `protocol: http` still describes what the component speaks on its own port ([D-59](DESIGN.md#d-59-providesprotocol-describes-the-components-own-listener)). Where TLS terminates, and which certificate it uses, stay outside the file ([D-5](DESIGN.md#d-5-proxy-is-a-platform-concern-not-an-app-concern), [D-15](DESIGN.md#d-15-routing-is-a-deployment-concern-not-an-app-concern)).

Six rules bind the entry:

1. **The type names an interface, never a product.** `https-origin` is an [origin](https://www.rfc-editor.org/rfc/rfc6454) whose scheme is `https` — never `caddy`, `traefik`, or `acme`.
2. **`endpoint:` names a `provides` entry by its `name`** ([named endpoints](#provides)). It is required on an `https-origin` entry and meaningless on any other type. The entry MUST sit on the **component that owns the endpoint**; at the top level of a file that declares `components:` it is a **validation error**, because top-level `requires` defaults into every component that declares none and one entry would face several `provides` lists. The name must match exactly one entry on that component; that entry must be `exposed: true` and declare an **HTTP-family** listener — `http`, `https`, `ws`, or `grpc`. Naming a `tcp` or `udp` entry is a **validation error**: those listeners have no origin.
3. **One per app, and it defines "primary".** At most one `https-origin` entry across all components; a second is a validation error. The named endpoint is the app's **primary** endpoint for `$app.*` derivation and for orchestrator-supplied publication context ([D-58](DESIGN.md#d-58-orchestrator-supplied-publication-context--app-under-an-owning-orchestrator) rule 4). **Declaring the entry fixes the primary** — whether or not a provider fulfills it — so `$app.url` never changes value with a provider's capability. It reaches `$app.*` only: `$components.<name>.url` is unaffected. With no entry declared, providers keep their own positional choice.
4. **One property: `url`** — the same value as `$app.url`, from one derivation. No `host`, `port`, `scheme`, `authority`, or `tls` property is registered; [`$app.*`](#app-properties) already standardises those.
5. **Fulfillment, no probe.** The provider provisions the origin, or accepts one supplied through its orchestrator-facing publication channel, or refuses with a clear message. A supplied URL whose scheme is not `https` is refused. The provider does not verify the origin exists or is reachable. See [PROVIDERS.md](PROVIDERS.md) §7 and §10 item 5.
6. **`supports:` is the optional mood.** Unfulfilled, the entry's `set_env` is absent and the provider notes the un-granted dependency — the app deploys and degrades.

```yaml
# mailpit — the endpoint reference takes whatever the app called it
provides:
  - name: web-ui
    protocol: http
    port: 8025
    exposed: true
  - name: smtp
    protocol: tcp
    port: 1025
    exposed: true
supports:
  - type: https-origin
    endpoint: web-ui        # `endpoint: smtp` would be a validation error (rule 2)
```

A `ws` endpoint behind an `https-origin` resolves `url` to `https://…`, not `wss://…`: `url` is fixed as the https origin for every admitted listener protocol. A `wss` spelling, if it ever arrives, arrives as a new property, never as a change to what `url` resolves to.

### Host capabilities

A `requires`/`supports` entry can request a **host capability** — a privileged grant from the machine the app runs on — instead of a backing service. A capability entry is marked with `host:`. The provider **grants** it (mounts or forwards the underlying coordinate and populates the capability's properties) or **refuses** the deployment with a clear message; it never provisions anything. See [PROVIDERS.md](PROVIDERS.md) for the provider-side contract.

```yaml
requires:
  - postgres                              # backing service → provision + wire
  - host: { container_runtime: docker }   # capability      → grant or refuse
    set_env:
      DOCKER_HOST: $url
supports:
  - host: { container_runtime: any }      # optional — deploy, probe, degrade
```

| Field | Type | Required | Description |
|---|---|---|---|
| `host` | `map<string, string \| bool>` | **yes** | Capability name → interface value (see [Capability vocabulary](#capability-vocabulary)) |
| `set_env` | `map<string, string>` | no | Maps capability properties to app env vars using `$` expressions |

Rules:

- **The `host:` marker is required on every privileged entry.** An entry's kind is machine-extractable from the file itself: a bare string or `type:` entry is a backing service; a `host:` entry is a capability. Anyone — tooling or a human reviewer — can list an app's full privilege surface with zero extra tooling. `launchfile validate` prints it as `host capabilities requested: […]`.
- **The value names an interface, never a product.** `container_runtime: docker` means "the Docker Engine API" — a Podman-compatible socket satisfies it — exactly as `requires: postgres` names a wire protocol, not a vendor. `container_runtime: any` is runtime-agnostic. The vocabulary is open: unknown capability names and values are tolerated by parsers; a provider that cannot grant a required capability it does not understand refuses.
- **Required vs optional is `requires` vs `supports`.** A capability in `requires` must be granted or the provider refuses to deploy the component. A capability in `supports` is optional: the app deploys without it, probes its env vars at startup, and degrades gracefully.
- **Wiring uses `set_env`,** exactly as for backing services. A granted capability exposes provider-supplied properties (below); bare `$prop` references inside the entry resolve against the enclosing capability's properties.

#### Capability properties

Like [resource properties](#resource-property-vocabulary), a granted capability exposes a standard set of properties the provider computes from how it granted the capability:

| Capability | Property | Meaning |
|---|---|---|
| `container_runtime` | `$socket` | Filesystem path of the runtime socket (e.g. `/var/run/docker.sock`) |
| `container_runtime` | `$url` | `DOCKER_HOST`-style connection string (e.g. `unix:///var/run/docker.sock`, `tcp://10.0.0.5:2376`) |
| `container_runtime` | `$api` | HTTP(S) API endpoint URL, when the runtime is reachable over the network |

Properties a provider cannot supply resolve to the empty string, matching unknown resource properties.

#### Capability vocabulary

| Capability | Values | Meaning |
|---|---|---|
| `container_runtime` | `docker`, `any` | Access to a container-runtime control API. `docker` = the Docker Engine API (any compatible socket satisfies it, including Podman's); `any` = runtime-agnostic. |
| `network` | `host` | Must share the host network stack |
| `filesystem` | `read-write`, `read-only` | Host filesystem access |
| `privileged` | `true` | Elevated privileges (e.g. device access) |

`network`, `filesystem`, and `privileged` are the entry-form spelling of the legacy [`host` block](#host) keys — they are grant/refuse capabilities like any other. That block is **deprecated in `launch/v1` and removed in `launch/v2`** ([D-54](DESIGN.md#d-54-the-legacy-host-block-is-deprecated-in-favor-of-capability-entries)); entries are the form to write. Existing files using the block stay valid and keep their meaning for the whole of `launch/v1` — see [Migrating off the `host:` block](#migrating-off-the-host-block).

## Supports

Declares optional resources that enhance the app when available. Same schema as `requires`. Env vars from `set_env` are only injected when the resource is actually provisioned. When they are, an injected value takes precedence over an `env:` declaration of the same name; when the entry is inactive the `env:` value applies unchanged and the binding's keys are absent — the rule is stated normatively in [PROVIDERS.md](PROVIDERS.md) §7 and binds every `requires`/`supports` binding.

```yaml
supports:
  - type: redis
    set_env:
      CACHE_URL: $url
      USE_CACHE: "1"
```

The literal `"1"` is injected alongside the dynamic `$url` -- `set_env` values without `$` are passed through verbatim.

`supports` entries can also request a [public HTTPS origin](#public-https-origins), a [certificate for native TLS](#native-tls-with-a-certificate-binding), or [host capabilities](#host-capabilities). The capability is optional: when the provider grants it, the entry's `set_env` vars are injected; when it doesn't, they are simply absent and the app degrades gracefully. A `supports` entry may declare [`uses`](#resource-uses) too; a declared use the provider cannot cover leaves the entry unfulfilled — bindings absent, a warning emitted — and never refuses the component.

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
| `secret` | 32 bytes of cryptographically random data, hex-encoded as 64 **lowercase** hexadecimal characters — suitable for signing keys, tokens. Use `\|base64` pipe for base64 encoding. | `a3f8b2c1d9e7...` (64 hex chars) |
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

Generated values are **minted once and then preserved** — a redeploy, rename, or domain change never regenerates them, since regeneration would invalidate sessions and encrypted data (see [Value provenance](#value-provenance)).

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

Because `generator: secret` produces exactly 32 bytes, the `APP_KEY` above decodes to the 32-byte key Laravel's default AES-256-CBC encrypter requires.

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

### Value provenance

Every declared env value has exactly one provenance class, determined by precedence: **`generator:` → expression `default:` → literal `default:` → user-supplied**. A `generator:` or a supplied `default:` satisfies `required:` — `required: true` alongside either asserts the value is non-empty at runtime; it does not change the class. Platform obligations follow the class:

- **Minted** (`generator:` present) — generated **once**, then preserved across redeploys and identity changes. `generator: port` is exempt: a port is an allocation, not an identity, so it is re-allocated rather than preserved.
- **Derived** (expression `default:` over platform-resolved inputs like `$app.url` or resource properties) — recomputed when its inputs change, unless an operator has overridden the deployed value.
- **Author default** (literal `default:`) — a starting value chosen by the file author; ordinary per-environment config the orchestrator may override.
- **User-supplied** (no generator, no default) — never supplied or altered by the platform, whether `required: true` or a bare declaration whose presence activates a feature.

`set_env` entries classify the same way: expression wirings are derived; literal wirings are deliberately constant and passed through verbatim — overriding one breaks the declared resource wiring rather than configuring the app. Whether a deployed value is currently the resolved default, an operator override, or a once-generated secret is orchestrator state, never recorded in the file. See [DESIGN.md D-49](DESIGN.md#d-49-env-value-provenance--four-declaration-classes-with-per-layer-obligations) for the full rationale.

## Commands

Lifecycle commands for build, release, run, and post-start stages. Each value is a **string** (shorthand) or an **object** with `command`, optional `timeout`, and optional [`capture`](#command-capture).

Platforms execute well-known commands in this order: **build → release → start → (bootstrap on user request)**. The `seed`, `test`, and `bootstrap` commands are invoked on demand, not as part of the standard deploy lifecycle.

| Stage | Purpose | When |
|---|---|---|
| `build` | Install dependencies, compile — **artifact prepare** | Every deploy |
| `install` | Prepare **from source** (deps, codegen) — the source-mode pair of `build` | Source-mode launches, on demand. See [Source-mode commands](#source-mode-commands) below. |
| `release` | Migrations, cache clear, asset compilation | Every deploy, after build |
| `start` | Start the application — **artifact run** | Every deploy, after release |
| `dev` | Start the application **from source** — the source-mode pair of `start` | Source-mode launches; preferred over `start` when running from source, ignored by artifact providers. See [Source-mode commands](#source-mode-commands) below. |
| `bootstrap` | Post-start setup that must run against a *running* component: create the first admin user, generate an initial invite link, write runtime config that depends on the deploy URL | On demand after `start` (user-invoked, re-runnable, non-deploy-failing). See [Bootstrap stage](#bootstrap-stage) below. |
| `seed` | Seed the database with initial data | On demand (first deploy or explicit trigger) |
| `test` | Run the test suite | On demand (CI or explicit trigger) |

One-time initialization that must complete before the app serves (schema install, first-run setup) belongs in `release`. Guard it with the app's own idempotent flags (install-if-needed) so it is safe to run on every deploy — the same idempotency recommendation the spec makes for [bootstrap](#bootstrap-stage). The stakes differ: `bootstrap` is user-invoked and non-deploy-failing, while `release` runs automatically on every deploy and a non-zero exit fails that deploy.

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

### Failure semantics

Every command has exactly one failure disposition, keyed on the **slot** it fills — not on its name. Keying on the name would be ambiguous, because [D-38](DESIGN.md#d-38-install--dev-source-mode-commands-and-the-source-field) lets one command fill a slot in either mode: source prepare resolves `install ?? build`, and source run resolves `dev ?? start`, so `build` and `start` each appear in two modes.

| Slot | Filled by | On failure |
|---|---|---|
| **prepare** | artifact mode: `build` · source mode: `install ?? build` | **Fails the invocation** — the deploy when deploying, the session when running from source. There is nothing to run either way. |
| **release** | `release` | **Fails the deploy.** `release` runs after the component's required resources are provisioned and ready, and before the run slot — so a failed migration never serves traffic. |
| **run** | artifact mode: `start` · source mode: `dev ?? start` | **Fails the invocation** — the component did not come up. |
| **bootstrap** | `bootstrap` | **Reported to the invoker** — never affects deploy status. |
| **on-demand** | `seed`, `test`, custom commands | **Reported to the invoker** — never affects deploy status. |

"Fails the invocation" is what makes the table non-overlapping: the prepare and run slots fail whatever asked for them. A deploy (`up`) fails; a source-mode session (`dev`) fails that session and leaves deployed state untouched. A component declaring only `start:` — no `dev`, no `image` — fills the run slot in source mode and is covered exactly once.

Timeout expiry is a failure with the same disposition as any other failure of that slot: a prepare or release that exceeds its `timeout` fails the invocation; a `bootstrap` that exceeds its `timeout` is reported.

A **health check** is not a command slot, but it has durations and therefore a disposition: a component that never becomes healthy **fails the invocation**, and an **unparseable health duration** fails it too — the provider surfaces the error rather than substituting a default, as it does for any other duration.

### Command interpretation

A command string is interpreted by a **POSIX shell**. Shell features — `&&`, `||`, `;`, pipes, redirection, variable expansion, grouping — are available and are what authors write today; `catalog/apps/paperclip`'s `bootstrap` is a multi-statement script and depends on it.

This is stated because it was ambiguous and the reference providers diverged on it: a provider that splits the string on whitespace and executes `argv[0]` directly will fail on any command using those features, and will fail confusingly — attempting to execute a binary whose name is the first token.

A provider that cannot offer a shell MUST report the command as unhonored (§10.8) rather than attempt a best-effort split.

### Durations

Every duration in a Launchfile uses one grammar:

```
^(\d+)(ms|s|m|h)$
```

An integer immediately followed by exactly one unit — `"500ms"`, `"30s"`, `"5m"`, `"2h"`. No internal whitespace, no compound values (`"1m30s"`), no fractions. The grammar governs `commands.*.timeout` and the [Health](#health) durations (`interval`, `timeout`, `start_period`).

An unparseable duration is surfaced as a non-fatal warning by `validate`. A provider MUST NOT silently substitute a default for an unparseable duration — it surfaces the error (see [PROVIDERS.md §10](PROVIDERS.md)). Numeric *defaults* for absent durations are provider-side: the spec does not mandate execution budgets, and each provider documents its own.

### Source-mode commands

Lifecycle commands run **in the context of the built artifact** — `start` is what the production image runs, `build` produces that artifact. Running the app **from source** on a developer machine is a different execution context: the artifact's entrypoint may be a compiled binary absent from the source tree, and the source tree has dev affordances (hot reload, unbundled assets) the artifact doesn't. Execution mode — source vs. artifact — is a *distinct* axis from deployment environment (DESIGN.md [D-37](DESIGN.md) / L-3): "dev" is a **mode**, not an environment.

Two well-known keys name the source-mode commands, and one optional component field names where they run:

| Key | Pairs with | Role | Example |
|---|---|---|---|
| `install` | `build` | source-mode **prepare** | `"bun install"` |
| `dev` | `start` | source-mode **run** | `"bun run dev"` |
| `source` *(component field)* | — | working directory for `install` / `dev` (defaults to `build.context`, then repo root) | `"./apps/api"` |

**Only prepare and run are mode-aware.** `release`, `bootstrap`, `seed`, and `test` are **mode-invariant** — the same command runs whether you launch from source or from the artifact. A path or binary that genuinely differs by mode (a cache dir, a repo-local CLI) belongs in `storage:` / `env` / the provider's `PATH`, not a separate command.

**Resolution (per component).** A provider selects one mode for the launch (`launchfile dev` → source, `launchfile up` → artifact) and resolves each component:

- **Run**, by precedence `dev` > `image` > `start`: a `dev` command runs the component from source; an `image` keeps it in artifact mode *unless* `dev` overrides it; a bare `start` runs from source only when there is no `image` — so a prebuilt image is never replaced by a `start` that assumes the image's internals (fallbacks must be detectably safe).
- **Prepare**: source mode runs `install ?? build`, **on demand** (first launch or a detected dependency/lockfile change), not on every run; artifact mode runs `build` (or pulls `image`).

Providers that execute the built artifact (Docker, Kubernetes, cloud platforms) **ignore** `install` and `dev`. The values are ordinary command values — string shorthand or the expanded form with `timeout` and [`capture`](#command-capture).

A Launchfile that declares both is launchable in either mode from the same file:

```yaml
components:
  api:
    source: ./apps/api                  # cwd for install/dev
    image: ghcr.io/acme/api:1.4         # artifact run (ENTRYPOINT = compiled binary)
    commands:
      install: "bun install"            # source prepare
      dev: "bun src/index.ts --port $PORT"   # source run
      bootstrap: "api-cli create-admin --url $app.url"  # mode-invariant
```

`launchfile up` pulls and runs the image; `launchfile dev` runs `bun install` (on demand) then `bun src/index.ts` from `./apps/api`, ignoring the image. `bootstrap` is identical in both modes. Source mode is a deliberately narrow carve-out: it expresses that the *same lifecycle intent* needs a different command line from source than from the artifact — it is **not** an environment-override mechanism (staging vs. production config remains an orchestrator concern, DESIGN.md L-3).

### Bootstrap stage

The `bootstrap` stage is for imperative post-start setup that can only run against a **running** component. Typical uses:

- Creating the first admin user via a CLI that's only available inside the container
- Generating a one-time invite link or password reset token the user needs to see
- Writing runtime configuration whose values depend on the deployment's public URL (via `$app.url`) and must be picked up by an already-running process

Unlike `release`, which runs before `start` in an ephemeral container and fails the whole deploy on error, `bootstrap` runs **after** `start` against the running component, is invoked on user request (not automatically after deploy), is **re-runnable**, and failures are **reported** rather than deploy-failing. It is the place to encode operational knowledge that today lives in READMEs (*"after deploying, run `docker exec … <app-cli> create-admin`"*).

Bootstrap commands should be written to be idempotent — running them a second time should either no-op or produce a new one-time credential, not corrupt state. The spec recommends idempotency; it does not enforce it.

```yaml
commands:
  start: "node server.js"
  bootstrap:
    command: "my-app-cli create-admin --url $app.url"
    capture:
      invite_link:
        pattern: "https?://\\S+"
        description: "One-time invite link"
        sensitive: true
```

### Command Capture

Any command that uses the expanded form can declare **captures** — named values extracted from the command's stdout via regex patterns. The platform matches each capture's regex against the command's stdout and stores the first capture group's value (or, if the pattern has no capture group, the full match).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `pattern` | `string` | **yes** | -- | Regex matched line-by-line against the command's stdout |
| `description` | `string` | no | -- | Human-readable description of the captured value |
| `sensitive` | `boolean` | no | `false` | If `true`, value is masked in API/UI unless explicitly revealed |

Captured values are surfaced by the platform under a `$outputs.*` namespace and made available through the platform's API or UI. If a pattern does not match any line, the capture is absent (not an error).

Capture is most commonly used with `release` (for migration-time generated values) and `bootstrap` (for post-start admin creation and invite flows), but is allowed on any command that uses the expanded form:

```yaml
commands:
  release:
    command: "./setup.sh"
    capture:
      admin_password:
        pattern: "Admin password: (.+)"
        description: "Generated admin password from initial setup"
        sensitive: true
      admin_url:
        pattern: "Dashboard: (https?://\\S+)"
        description: "URL to the admin dashboard"
  bootstrap:
    command: "my-app-cli create-invite --url $app.url"
    capture:
      invite_link:
        pattern: "https?://\\S+"
        description: "One-time invite link — open in a browser to register"
        sensitive: true
```

> **Note on D-23 placement supersede.** Earlier versions of this spec documented capture via a top-level `outputs:` field at component level. That placement has been superseded by the nested `capture:` form documented above. The capture mechanism (`pattern` / `description` / `sensitive`) is preserved verbatim; only the location of the capture block in the schema has changed. See [DESIGN.md D-34](DESIGN.md#d-34-capture-block-co-located-with-commands-supersedes-d-23-placement) for the migration rationale.

## Health

Health check configuration. Value is a **string** (shorthand for HTTP path) or an **object**.

A string shorthand (`health: /health`) expands to `{ path: "/health" }`.

| Field | Type | Description |
|---|---|---|
| `path` | `string` | HTTP path to check |
| `command` | `string` | Shell command for non-HTTP checks |
| `interval` | `string` | Check interval — a [duration](#durations) (e.g. `30s`, `1m`) |
| `timeout` | `string` | Timeout per check attempt — a [duration](#durations) |
| `retries` | `integer` | Consecutive failures before unhealthy (min: 1) |
| `start_period` | `string` | Grace period before failures count — a [duration](#durations) |

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

## Source

The working directory for **source-mode commands** (`install` / `dev`). When a provider runs the app from source (`launchfile dev`), `install` and `dev` execute in this directory. Defaults to `build.context`, then the repository root.

```yaml
components:
  api:
    source: ./apps/api      # install/dev run here
    commands:
      install: "bun install"
      dev: "bun run dev"
```

`source` has no effect in artifact mode — providers that run the built artifact ignore it. See [Source-mode commands](#source-mode-commands) for the full resolution rules and the `dev` > `image` > `start` precedence.

## Storage

Declares persistent volumes. Value is a map of named volumes.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | **yes** | -- | Mount path inside the container |
| `size` | `string` | no | -- | Minimum size hint (e.g. `512MB`, `10GB`) |
| `persistent` | `boolean` | no | `true` | Whether data survives restarts |
| `content` | `string` | no | -- | Who supplies the volume's content. Only value: `operator` — the operator supplies it; a provider must never initialize the volume empty ([D-50](DESIGN.md#d-50-storagenamecontent-operator--operator-supplied-volume-content-bound-by-the-orchestrator-or-refused)) |

If you're declaring named storage, you probably want it to survive restarts — hence the default. Use `persistent: false` explicitly for ephemeral scratch space like caches.

`content: operator` marks a volume whose content the platform cannot create — a music library, a photo collection, the files a file manager browses. It declares *who fills the volume*, never where that content lives: the host path changes per machine, so it stays with the orchestrator — `launchfile up --storage <volume>=<path>` (repeatable; `--storage <component>.<volume>=<path>` where ambiguous), and a provider may accept the same map from its own config. A provider MUST either **bind** the operator-supplied content at `path`, or **refuse** the component with a clear error naming the volume and the flag that would satisfy it. It MUST NOT create an empty volume and start the app, and MUST NOT create a supplied path that is absent or unreadable on the host ([D-50](DESIGN.md#d-50-storagenamecontent-operator--operator-supplied-volume-content-bound-by-the-orchestrator-or-refused)). `persistent` is not applicable on a marked volume — the operator's directory outlives the deployment by construction — so providers ignore it there, and a validator MAY warn that `persistent: false` beside the marker is a contradiction. `$storage.<name>.path` resolves as usual (see [Storage Properties](#storage-properties)): the container path is still the mount point.

```yaml
storage:
  uploads:
    path: /app/uploads
    size: 10GB
  cache:
    path: /app/cache
    size: 512MB
    persistent: false
  music:
    path: /music
    content: operator    # the operator's library — bind it or refuse, never create empty
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

> **Deprecated.** The whole top-level `host:` block is deprecated in `launch/v1` and is removed in `launch/v2` ([D-54](DESIGN.md#d-54-the-legacy-host-block-is-deprecated-in-favor-of-capability-entries)). Its replacement is the [host capability](#host-capabilities) entry form in `requires`/`supports`. Files using the block **stay valid for the whole of `launch/v1`** and keep their exact meaning — `launchfile validate` reports the deprecation and its migration, and never fails on it. Write new files with capability entries; migrate existing ones using the table below.

Declares host-level capabilities the app requires that cannot be satisfied inside a standard container. When a deployer cannot meet these constraints, it should refuse the deployment with a clear error message rather than failing at runtime.

| Field | Type | Description |
|---|---|---|
| `docker` | `enum` | `required` -- needs Docker daemon access on the host (not Docker-in-Docker). `optional` -- enhanced when available. |
| `network` | `enum` | `host` -- must share the host network stack. `bridge` (default) -- standard container networking. |
| `filesystem` | `enum` | `read-write` -- needs persistent host filesystem access. `read-only` -- only reads from host. `none` (default) -- no host filesystem needed. |
| `privileged` | `boolean` | Requires elevated privileges (e.g. device access). Default `false`. |

```yaml
# App that orchestrates Docker containers on the host (deprecated block form)
host:
  docker: required
  network: host
  filesystem: read-write
```

When `host.docker` is `required`, the deployer must ensure the app runs with access to the Docker daemon socket (e.g. `/var/run/docker.sock`). If the deployer's execution strategy is container-based, it should either refuse or warn that Docker-in-Docker is unreliable.

### Migrating off the `host:` block

Every key of the block is expressible as a [host capability](#host-capabilities) entry, and the two spellings are semantically identical — a provider MUST produce the same grant/refuse outcome for either (`PROVIDERS.md` § Host capabilities). `requires` carries a capability the app cannot run without; `supports` carries one it degrades gracefully without. A key set to its default declares no need at all, so it migrates to nothing.

| Legacy key/value | Migrates to |
|---|---|
| `docker: required` | `requires: [ - host: { container_runtime: docker } ]` |
| `docker: optional` | `supports: [ - host: { container_runtime: docker } ]` |
| `network: host` | `requires: [ - host: { network: host } ]` |
| `network: bridge` | *(default — drop the key, no entry)* |
| `filesystem: read-write` \| `read-only` | `requires: [ - host: { filesystem: <value> } ]` |
| `filesystem: none` | *(default — drop the key, no entry)* |
| `privileged: true` | `requires: [ - host: { privileged: true } ]` |
| `privileged: false` | *(default — drop the key, no entry)* |

The entry form also gains what the block cannot express: `set_env` wiring of the granted coordinates (`$socket` / `$url` / `$api` for `container_runtime`), and a single home for the app's whole dependency statement instead of two parallel mechanisms.

```yaml
# The block above, migrated
requires:
  - host: { container_runtime: docker }
    set_env:
      DOCKER_HOST: $url
  - host: { network: host }
  - host: { filesystem: read-write }
```

### How deprecations are declared

Deprecation is machine-readable, never prose-only ([D-42](DESIGN.md#d-42-deprecation-metadata-model--the-p-14-mechanism)). Every deprecated part of the format carries its metadata in the JSON Schema, in two places:

1. The standard JSON Schema `deprecated: true` keyword (draft 2020-12), which every `$schema`-aware editor already understands.
2. An `x-launchfile-deprecation` object carrying D-42's four semantic parts, which JSON Schema has no vocabulary for:

```json
"x-launchfile-deprecation": {
  "deprecated_in": "launch/v1",
  "removed_in":    "launch/v2",
  "replacement":   "requires[].host.container_runtime",
  "hint":          "Replace `host: { docker: required }` with `requires: [ - host: { container_runtime: docker } ]`. …"
}
```

`deprecated_in` and `removed_in` are `launch/vN` format versions — the only version vocabulary the format has ([D-17](DESIGN.md#d-17-version-header-for-spec-versioning)) — and removal is always at a format major ([P-14](DESIGN.md#p-14-legible-evolution)). Both keys carry the same values everywhere a block and its keys are deprecated together; `replacement` and `hint` are per-key, because they differ per key.

Tooling reads this metadata and reports it. In the reference SDK, `launchfile validate` emits a `deprecations` array — one entry per deprecated field present in the file, with all four parts populated — in `--json` output, and a `deprecated:` line per finding in the human output. A deprecation **never** affects `valid` and never changes the exit code: deprecation warns, removal migrates, nothing breaks.

## Runtime

Runtime identifier declaring what language or platform the app needs. Platforms MAY use this to select a base image or buildpack.

Valid values: `node`, `bun`, `deno`, `python`, `ruby`, `go`, `rust`, `java`, `php`, `elixir`, `csharp`, `static`.

```yaml
runtime: node
```

The `runtime` field is metadata — it describes the app, not the infrastructure. Changing the deployment target (Docker → Kubernetes → bare metal) does not change the runtime value.

### Version is not part of `runtime`

The `runtime` field does not include a version. Platforms and AI analyzers should discover the version from ecosystem-standard files already in the repo:

| Runtime | Version source |
|---|---|
| `node` | `.nvmrc`, `.node-version`, `.tool-versions`, `package.json` `engines.node` |
| `bun` | `.bun-version`, `.tool-versions`, `package.json` `engines.bun` |
| `python` | `.python-version`, `.tool-versions`, `pyproject.toml`, `Pipfile` |
| `ruby` | `.ruby-version`, `.tool-versions`, `Gemfile` |
| `go` | `go.mod` (first `go` directive) |
| `java` | `.java-version`, `.tool-versions` |

This avoids duplicating version information that already has a canonical source. If you need bun 3.1.13 or greater, declare it in `.tool-versions` or `package.json`:

```
# .tool-versions
bun 3.1.13
```

### Relationship to `image` and `build`

`runtime`, [`image`](#image), and [`build`](#build) serve different purposes and can coexist:

| Combination | Meaning |
|---|---|
| `runtime` only | Platform selects a buildpack or base image |
| `build` only | Build from source; platform infers runtime from Dockerfile |
| `image` only | Use pre-built image; no build step |
| `runtime` + `build` | Build from source; `runtime` is metadata |
| `runtime` + `image` | Use pre-built image; `runtime` is metadata |
| `build` + `image` | Build from source; `image` is the name/tag for the resulting artifact |
| All three | Build from source, tag as `image`, `runtime` is metadata |

Think of it like Docker Compose: `build` is how you create the image, `image` is the name/tag of the resulting artifact. When only `image` is provided, there's nothing to build — the platform pulls it directly.

## Image

A pre-built OCI container image reference. When `image` is present, the platform pulls this image instead of building from source.

```yaml
image: ghcr.io/hedgedoc/hedgedoc:1.9.9
```

See [Relationship to `image` and `build`](#runtime) for how `image` interacts with `runtime` and `build`.

## Repository

The app's **canonical source origin** — the URL of the repository the app is developed in.

```yaml
repository: https://github.com/hedgedoc/hedgedoc
```

Beyond identifying the project (catalog listings, tooling links), `repository` is the origin a provider falls back to when it needs the source tree and was not handed one — the **detached** case in the source-acquisition precedence defined in [PROVIDERS.md § Source acquisition](PROVIDERS.md#source-acquisition-d-43). A Launchfile read from within the app's own source tree is **attached**: that tree is the source, and `repository` is not consulted for acquisition. An orchestrator-supplied source (a different repo, ref, or local tree) always takes precedence over both.

### Baseline ref fragment

For a git-hosted URL, everything after the first `#` is a git ref — a branch, tag, or commit SHA:

```yaml
repository: https://github.com/hedgedoc/hedgedoc#develop
```

A bare URL means the repository's default branch. The fragment is the **baseline** the declaration describes, not a deployment choice: it lets one app ship multiple Launchfiles as distinct variants (a stable release and an edge build), each ref-stable across every deployment target. Which ref a given *deployment* uses remains orchestrator knowledge — an orchestrator-supplied source **always overrides** the fragment, so the baseline is a default, never a lock.

The fragment rule is defined for git-hosted URLs only; on any other URL a fragment has no defined meaning and providers ignore it. The fragment names *which ref of the origin*, never a directory within it — the working directory inside the tree is [`source`](#source). Tools that display `repository` as a link should strip the fragment.

Fetching and building a remote origin executes code from that origin — the per-source confirmation rules in [Execution modes and source trust](#execution-modes-and-source-trust) apply.

## Other Fields

| Field | Type | Description |
|---|---|---|
| `restart` | `enum` | Restart policy: `always` (restart unconditionally), `on-failure` (restart only on non-zero exit), `no` (never restart) |
| `schedule` | `string` | Cron expression for scheduled jobs |
| `singleton` | `boolean` | When `true`, the platform must not run more than one instance of this component |
| `platform` | `string \| string[]` | OCI platform constraint (e.g. `linux/amd64`, `linux/arm64`) |
| `host` | `object` | **Deprecated** (`launch/v1` → removed in `launch/v2`, [D-54](DESIGN.md#d-54-the-legacy-host-block-is-deprecated-in-favor-of-capability-entries)) — host-level constraints. Use [host capability](#host-capabilities) entries instead; see [Host](#host) |

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
| `$resource.use.prop` | Property a declared use of a named resource registers (see [Resource uses](#resource-uses)) |
| `$resource.use.name.prop` | Property a named occurrence of a repeatable use registers, like `$redis.db.cache.url` (see [Resource uses](#resource-uses)) |
| `$components.name.prop` | Property from another component's provides |
| `$components.name.endpoint.prop` | Property from a named endpoint on another component |
| `$secrets.name` | App-wide generated secret |
| `$app.prop` | Platform-injected app property (see [App Properties](#app-properties)) |
| `$app.endpoints.name.prop` | Public address of a named published endpoint (see [Per-endpoint properties](#per-endpoint-properties)) |
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

1. Starts with `app` -- platform-injected app property (see [App Properties](#app-properties)); `app.endpoints.<name>.<prop>` is the per-endpoint form (see [Per-endpoint properties](#per-endpoint-properties))
2. Starts with `secrets` -- app-wide secret lookup
3. Starts with `components` -- component endpoint lookup
4. Starts with `storage` -- provider-resolved storage path (see [Storage Properties](#storage-properties))
5. Single segment -- enclosing resource property (e.g. `$url` inside a `set_env` block)
6. On a resource whose entry declares `uses`, a three-or-more-segment path -- `resource.use.property`, or `resource.use.name.property` where the entry names the use, resolved only from that use's registered properties; an undeclared use or name, or an unregistered property, is an error, not an empty string (see [Resource uses](#resource-uses))
7. Multi-segment -- first segment is the resource name (defaults to `type`, overridden by `name`), rest is property path

The `app` and `storage` namespaces are reserved: each is checked before any user-named resource and cannot be shadowed by one. If a `requires:` entry is named `app`, or a `storage:` volume or resource is named `storage`, expressions like `$app.url` and `$storage.cache.path` still resolve via their reserved tables rather than against that resource — use a different name to avoid the reserved words.

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
  CACHE_DIR: $storage.cache.path                             # provider-resolved storage path
  DB_FILE: "${storage.data.path}/app.db"                      # storage path + suffix
```

## App Properties

The `$app.*` namespace exposes platform-injected properties of the deployed app itself. These are resolved at deploy time by whichever provider is running the app, so a Launchfile can reference its own public URL without hardcoding environment-specific values.

| Property | Description |
|---|---|
| `$app.url` | The app's public URL (e.g. `https://myapp.example.com`) |
| `$app.host` | The app's public hostname (e.g. `myapp.example.com`) |
| `$app.port` | The app's allocated public port number |
| `$app.name` | The app name as deployed |
| `$app.authority` | The app's public host **and** port, port omitted when it's the default for the scheme (e.g. `myapp.example.com` or `myapp.lvh.me:10001`) |
| `$app.scheme` | The public URL's scheme — `http` or `https` |
| `$app.tls` | Whether the public URL is HTTPS — the string `true` or `false` |

The values are determined by the provider's routing strategy at deploy time. A Cloudflare Tunnel deployment might resolve `$app.url` to `https://myapp.example.com`; a local development provider might resolve it to `http://myapp.lvh.me:10001`; a Kubernetes deployment behind an Ingress might resolve it to `https://myapp.k8s.internal`. The Launchfile stays the same.

The standard set above is the portable vocabulary every provider must support. Providers MAY expose additional `$app.*` properties (e.g. `$app.region`, `$app.deployment_id`) as platform-specific extensions; portable Launchfiles should use only the standard set. Unknown `$app.*` properties resolve to empty string, matching the behavior of unknown resource properties (see [L-4](DESIGN.md#l-4-resource-property-vocabulary-is-implicit)).

`$app.url` differs from `$components.<this>.url` in two ways. First, it gives the *public* URL — the address external users reach the app on — not the internal component port. Second, it works in single-component mode where there is no component name to reference. Use `$app.url` for public-facing values (auth callback URLs, webhook registration, public-facing email links) and `$components.<name>.url` for internal cross-component wiring.

Similarly, `$app.port` is the allocated *external* port that the platform exposes; `provides[].port` is the *container* port the component binds inside its sandbox. They can differ — a component might bind `3000` while the platform exposes `10001`.

`$app.authority`, `$app.scheme`, and `$app.tls` are derived directly from `$app.url`, so a provider that can resolve the URL can resolve all three. `$app.authority` is the [WHATWG URL `host`](https://url.spec.whatwg.org/#dom-url-host) — the hostname plus the port, with the port omitted when it is the default for the scheme (`:443` under `https`, `:80` under `http`). `$app.scheme` is the URL scheme (`http` or `https`); `$app.tls` is the boolean form of that scheme (`true` when `https`, else `false`), provided for apps whose config expects a literal SSL on/off flag rather than a scheme string. Prefer `$app.url` for the single-string case; reach for these three only when an app needs the public address split into its component fields.

Example use:

```yaml
env:
  PUBLIC_URL: $app.url                # Drupal, BookStack, Mealie, Firefly III
  BETTER_AUTH_URL: $app.url           # better-auth callback base
  OAUTH_REDIRECT_URI: "${app.url}/oauth/callback"
  WEBHOOK_URL: "${app.url}/webhooks/incoming"

  # Apps that need the public address split into separate fields (HedgeDoc):
  CMD_DOMAIN: $app.authority          # public host[:port] HedgeDoc serves from
  CMD_PROTOCOL_USESSL: $app.tls       # whether the public URL is HTTPS
  CMD_URL_ADDPORT: "false"            # authority already carries the public port
```

### Per-endpoint properties

`$app.*` describes the app's **primary** endpoint only. An app that publishes more than one endpoint reaches the others through `$app.endpoints.<name>.*`, where `<name>` is the `provides` entry's `name:` ([named endpoints](#provides)) and the entry is `exposed: true` ([D-63](DESIGN.md#d-63-appendpointsname--per-endpoint-publication-context)):

| Property | Description |
|---|---|
| `$app.endpoints.<name>.url` | The endpoint's public URL; `""` for a `tcp` or `udp` endpoint, which has no origin |
| `$app.endpoints.<name>.host` | The endpoint's public hostname |
| `$app.endpoints.<name>.port` | The published host-side port the provider allocated for that endpoint — never the container port |
| `$app.endpoints.<name>.authority` | Public host **and** port, port omitted when it is the scheme default; a `tcp`/`udp` endpoint always carries its port |
| `$app.endpoints.<name>.scheme` | The public URL's scheme — `http` or `https`; `""` for a `tcp` or `udp` endpoint |
| `$app.endpoints.<name>.tls` | The string `true` when the scheme is `https`, else `false` |

The six are the standard `$app.*` set less `name`, each defined per endpoint exactly as [App Properties](#app-properties) defines it for the primary, and each is a **public** address: `$components.<name>.*` stays the component-side address. Five rules:

1. A provider computes every endpoint's address through the same derivation it uses for `$app.*`. Where a provider publishes a per-endpoint address, the **primary** endpoint's `$app.endpoints.<name>.url` **is** `$app.url` — the same value, never a second computation.
2. `scheme`, `tls` and `url` read the entry's **effective** listener ([Native TLS](#native-tls-with-a-certificate-binding)): an active certificate binding makes them read `https` and `true`.
3. Unnamed endpoints are not addressable — add a `name:`. An endpoint name is app-wide: the same name on two components is a **validation error** naming both.
4. Anything else resolves `""` with a `validate` warning naming it: an unknown name, a named endpoint that is not `exposed: true`, `$app.endpoints` with no name, `$app.endpoints.<name>` with no property, a property outside the six, and an endpoint the provider publishes no address for (`@launchfile/macos-dev` and `@launchfile/aws` today, where this reaches the primary too and `$app.url` keeps its own value). A `tcp`/`udp` endpoint's `""` `url` and `scheme` are a defined answer and draw no warning.
5. An orchestrator-supplied publication context asserts the **primary** endpoint's address only ([D-58](DESIGN.md#d-58-orchestrator-supplied-publication-context--app-under-an-owning-orchestrator) rule 4): while one is supplied, every other named endpoint resolves `""`.

```yaml
# gitea — the clone URL wants the published SSH address in two pieces
provides:
  - name: web
    protocol: http
    port: 3000
    exposed: true
  - name: ssh
    protocol: tcp
    port: 22
    exposed: true
env:
  GITEA__server__ROOT_URL:
    default: $app.url                        # the primary — same value as $app.endpoints.web.url
  GITEA__server__SSH_DOMAIN:
    default: $app.endpoints.ssh.host         # the published SSH hostname
  GITEA__server__SSH_PORT:
    default: $app.endpoints.ssh.port         # the published SSH port, not 22
```

## Storage Properties

The `$storage.*` namespace exposes the filesystem path the provider actually provisioned for a declared `storage:` volume, resolved at deploy time by whichever provider is running the app. It lets an app put *its own* storage location into the environment without hardcoding a path that only one provider understands.

| Property | Description |
|---|---|
| `$storage.<name>.path` | The path the provider provisioned for the volume named `<name>` |

The declared `storage.<name>.path` is the *canonical* path — the mount point inside the container. `$storage.<name>.path` is the *resolved* path the running provider used:

- a **container provider** bind-mounts the volume at the declared path, so `$storage.<name>.path` equals the declared `path` (e.g. `/data/cache`);
- a **native (non-container) provider** provisions a host directory, so `$storage.<name>.path` resolves to that directory (e.g. `<project>/.launchfile/storage/<component>/cache`).

The same Launchfile is therefore correct under both. `storage` is a reserved namespace, checked before any user-named resource and not shadowable by one (see [Resolution order](#expression-syntax)). Unknown `$storage.*` — a typo'd volume name, or a provider that does not populate the map — resolves to empty string, matching unknown `$app.*` (see [L-4](DESIGN.md#l-4-resource-property-vocabulary-is-implicit)). Only `.path` is exposed; the author-declared `size` hint is not echoed back ([D-39](DESIGN.md#d-39-storagenamepath-for-provider-resolved-storage-paths)).

Example use:

```yaml
storage:
  cache:
    path: /data/cache
    persistent: false
  data:
    path: /data
env:
  CACHE_DIR: $storage.cache.path       # anythingllm STORAGE_DIR, broker cache dir
  MP_DATABASE: "${storage.data.path}/mailpit.db"   # mailpit — path + suffix
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
| `https-origin` | `url` |
| `certificate` | `cert_file`, `key_file` |

Not every type registers `url`: [`certificate`](#native-tls-with-a-certificate-binding) registers two app-filesystem paths and no address at all. Where a type does register it, the `url` property is the fully-formed address of the resource — a connection string for a backing service (e.g. `postgresql://user:pass@host:5432/dbname`), and the public origin for [`https-origin`](#public-https-origins) (e.g. `https://vault.example.com`, the same value as `$app.url`). Where a type registers more than one property, the others provide individual components for apps that require them separately.

`key_file` — and every `*_key` / `*_key_file` property name, in any type's vocabulary or outside one — is **credential-bearing**: a provider registers its value with its redactor before generating anything, exactly as it does for `password`, `secret_key` and `access_key` ([D-56](DESIGN.md#d-56-orchestrator-satisfied-requiressupports--the-supplied-resource-channel) rule 5). Membership of a type's vocabulary never turns that off.

This vocabulary is also published in machine-readable form as [`schema/resource-properties.json`](schema/resource-properties.json), which adds a one-line semantic per property and is what tooling reads for advisory typo warnings (see [DESIGN.md D-46](DESIGN.md#d-46-resource-property-registry--vocabulary-is-standard-but-open)).

The table above is the **portable** vocabulary: every provider that supports a listed type must expose those properties under those names. It is authoritative but **not closed** — a provider MAY expose additional properties for a listed type as a platform-specific extension, mirroring the `$app.*` rule above. Portable Launchfiles should use only the standard set. A reference outside the standard set is therefore not invalid: tooling reports it as an **advisory warning**, never a validation error, because it may be either a typo or a deliberate provider extension. Unknown properties resolve to empty string.

Resource types are extensible -- any string is accepted. Unknown types have no predefined property vocabulary; their properties are platform-defined, and no warning is reported for them.

## Resource Use Vocabulary

A `requires`/`supports` entry may declare which features of the resource the app uses (see [Resource uses](#resource-uses)). Each type that has a use vocabulary lists its tokens here, with the properties each registers under `$<resource>.<use>.<property>`:

| Resource | Use | Registers | Repeatable | Meaning |
|---|---|---|---|---|
| `redis` | `db` | `url`, `index` | yes | One logical database (keyspace) on the instance, selected by index: `url` is `redis://[user:password@]host:port/<index>`, `index` the integer |
| `redis` | `pubsub` | — | no | Publish/subscribe channels. Pub/sub ignores database numbers, so isolated channels need an instance the app does not share channels on |
| `redis` | `server` | — | no | The whole server: keyspace notifications, `CONFIG`, `SELECT` across databases, `FLUSHALL`, modules — anything that assumes the app owns the instance |
| `postgres` | `database` | `url`, `name` | yes | One database on the server: `url` is the standard connection URL with `/<name>` as its path, `name` the database name |
| `postgres` | `server` | — | no | The whole server: superuser access, `CREATE DATABASE`, server-wide settings |
| `mysql` | `database` | `url`, `name` | yes | One database on the server: `url` is the standard connection URL with `/<name>` as its path, `name` the database name |
| `mysql` | `server` | — | no | The whole server: root access, `CREATE DATABASE`, server-wide settings |

A **repeatable** use may occur more than once on one entry, each occurrence named as a single-key map (`- db: cache`) and addressed as `$<resource>.<use>.<name>.<property>`; a name on a non-repeatable use is a validation error (see [Resource uses](#resource-uses)). A use that registers nothing (`—`) is addressed through the entry's instance properties. The entry-level properties (`$url`, `$host`, `$port`, `$password`, `$name`) are unchanged by any declared use.

This vocabulary is published in machine-readable form under the `uses` key of [`schema/resource-properties.json`](schema/resource-properties.json), a sibling of `types`: these are features an author declares, not properties a provider publishes. It is **open** in the same way the property vocabulary is: a token outside the table is an advisory `validate` warning, never a validation error. It is not open at deploy time — a provider refuses a `requires` entry declaring a token it does not recognise, because no provider can claim to cover a use it does not know. A type absent from the table has no use vocabulary; its tokens are provider-defined and draw no warning.

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

`commands.start`, `commands.build`, `commands.install`, `commands.dev`, `commands.release`, and `health.command` contain shell commands that the provider executes — and `install`/`dev` run **natively on the host** in source mode (see [Execution modes and source trust](#execution-modes-and-source-trust)). This is by design — the user chose to run this Launchfile. Providers that fetch Launchfiles from remote sources (catalogs, URLs) should display what will be executed and prompt for confirmation before running.

### Execution modes and source trust

A Launchfile can be executed in four modes, with different trust requirements. Where the app's code runs determines how much the user must trust the source:

| Mode | What executes where | Appropriate for |
|---|---|---|
| **Dev launch from source** | `install` / `dev` commands run natively on the host, in the project directory | Repos the user owns or has reviewed — the commands have full user-level access to the machine |
| **Containerized build + run** | `build:` runs inside `docker build`; the app runs inside a container | Unknown or third-party repos — neither the build nor the app touches the host beyond declared ports and volumes |
| **Image run** | A pre-built `image:` is pulled and run in a container | Catalog apps; trust shifts to the image publisher |
| **Cloud build + deploy** | Build and run both happen on remote infrastructure | Production; the platform's isolation applies |

Guidance for providers:

- **Native (source-mode) providers SHOULD only run local sources.** Running `install` / `dev` commands from a freshly fetched URL or catalog entry executes unreviewed code with user privileges. If a native provider supports remote sources at all, it MUST show the commands and prompt.
- **Container-based providers are the sandboxed path for untrusted sources.** A `build:` config keeps the entire build inside `docker build` — dependency install scripts, codegen, and compilers never execute on the host. Remote build contexts (git URLs) extend this: the provider never even clones the repo onto the host itself.
- **The confirmation prompt is per-source, not per-field.** Before executing a remote Launchfile, show the user what will run: images to pull, components built from source, resources provisioned, and host capabilities requested.

### Host capabilities require user consent

`host.privileged`, `host.docker`, and `host.filesystem` — and equivalently the `host:`-marked capability entries in `requires`/`supports` (see [Host capabilities](#host-capabilities)) — declare elevated capabilities. Providers should either refuse or require explicit user confirmation before granting these. The required `host:` marker makes the full privilege surface extractable from the file itself; `launchfile validate` surfaces it as a `host capabilities requested:` summary.

### Secrets and state

Generated secrets (from `generator: secret|uuid`) and connection credentials should be stored with restrictive file permissions (e.g., 0600) and excluded from version control.

## Extensibility

The format is designed for additive evolution:

- New fields can be added at any level without breaking existing files
- Unknown fields are ignored by parsers that do not support them
- No custom YAML tags (`!tag`) are used or required
- The `version` field enables future breaking changes via versioned schemas
