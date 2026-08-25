# @launchfile/macos-dev

## 0.4.0

### Minor Changes

- [#194](https://github.com/launchfile/launchfile/pull/194) [`67b400e`](https://github.com/launchfile/launchfile/commit/67b400ed3ecc6ed741a2d2f332a9563cddb0518a) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - A declared `generator:` now outranks a declared `default:` when both appear on the same env var (D-49 provenance precedence).
  
  Previously `resolveComponentEnv` filled the default first and `resolveGenerators` skipped any key already set, so this provider resolved to the literal where `@launchfile/docker` and `@launchfile/aws` minted a value — the same file producing two different answers.
  
  No shipped catalog app declares both fields on one variable, so no published Launchfile changes behavior.

- [#193](https://github.com/launchfile/launchfile/pull/193) [`c9404d9`](https://github.com/launchfile/launchfile/commit/c9404d9bce10d27fd67d5d74e0667459ea31a1aa) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Lifecycle failure semantics + duration grammar (D-48). `validate` now warns on any duration outside the ratified grammar `^(\d+)(ms|s|m|h)$` (`commands.*.timeout`, `health.interval`/`timeout`/`start_period`); the SDK exports `parseDurationMs`/`isValidDuration`/`lintDurations`. The docker provider now executes a declared `release` before `start` as a one-shot `docker compose run --rm` (resources ready first via `depends_on`) and fails the deploy on error. Both providers surface an unparseable duration instead of silently substituting a 120s default: release/prepare fail the deploy/launch, bootstrap reports the failure.
  
  **Release commands now run in a shell.** `@launchfile/docker` previously split a release command on whitespace and executed the first token directly, so `release: "a && b"` ran only `a` and passed `&&` along as a literal argument. The command is now handed to `sh -c` inside the one-shot container, matching `@launchfile/macos-dev` and SPEC.md § Command interpretation. This requires a shell in the image; a release on a distroless or scratch image now fails with a surfaced `sh: not found` rather than silently running part of the command.

- [#226](https://github.com/launchfile/launchfile/pull/226) [`19ecdfc`](https://github.com/launchfile/launchfile/commit/19ecdfc864dadf5e436600e2d0637659225bcd47) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Structured launch failures and `launchfile diagnose` ([#44](https://github.com/launchfile/launchfile/issues/44)). The SDK gains the shared failure vocabulary every provider reports through — `LaunchError`, `LaunchErrorContext`, the slot-keyed `LaunchPhase`/`LaunchSlot` enums, `dispositionForPhase` (the D-48 failure table), `slotForCommand`/`commandForSlot`, `buildLaunchErrorContext`, and the text-sanitizing helpers — all pure, with no I/O. `@launchfile/docker` captures a failing launch into that shape and redacts it at capture, inside the process that still holds the secret registry; it also registers author-declared `sensitive: true` values (D-18) and operator-supplied `required:` values (D-52) before anything is captured, and exports `dockerLaunchError`, `dockerErrorKey`, `declaredEnvKeys`, `registerSensitiveEnv`, and `registerSuppliedEnv`. The CLI persists one record per app at `~/.launchfile/errors/<key>.json` (mode `0600`, in a `0700` directory) and adds **`launchfile diagnose [id|slug]`**, with `--json`, to show why the last launch failed. A record is superseded by the next successful `up` and removed by `down --destroy`. Only env var *names* are ever stored — the record has no field a value can land in.
  
  **`launchfile up` now exits non-zero when a component never becomes healthy.** SPEC.md § Failure semantics has always said that a component which never becomes healthy fails the invocation; `@launchfile/docker` reported the 120s timeout as a warning and returned success anyway. It now fails, naming the components that never passed. A script that treated a slow-to-healthy app as a successful deploy will start seeing a non-zero exit — fix the app's health check, or read `launchfile diagnose`, which reports `phase: health`. A component that declares no health check is unaffected: it counts as healthy once its container is running. The 120s budget itself is unchanged.
  
  **A failed launch that started containers now appears in `launchfile list`.** The deployment index records what exists on the machine, not what succeeded. A health-gate failure is registered with status `unhealthy` — its containers are deliberately left running for inspection — and a `release` or `run` failure with status `unknown`, so `launchfile status`, `logs`, and `down` all reach a deployment that failed to come up, including via the `launchfile status / launchfile logs` the health failure prints. Failures refused before any container exists — `prereq`, `resolve`, `parse`, `provision`, `prepare` — still leave no entry.

- [#177](https://github.com/launchfile/launchfile/pull/177) [`ec18fcb`](https://github.com/launchfile/launchfile/commit/ec18fcb88be9549b10fca4091896e11d72c523c7) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `generator: secret` now emits the spec-defined output — 32 bytes of cryptographically random data, hex-encoded as 64 lowercase characters (D-47).
  
  **Both providers change observable output.** Neither emitted hex before: macos-dev produced 43 base64url characters, aws produced 32 alphanumeric characters. Both were already non-conforming to SPEC.md's shipped "cryptographically random hex string" wording.
  
  **`@launchfile/aws` — existing stacks rotate their secret.** The generated resource changes from `random_password` to `random_bytes`. Those are different Terraform resource types, so a `moved` block cannot bridge them and the next `terraform apply` will destroy and recreate. Any value encrypted at rest under the old secret — a Laravel `APP_KEY`, outline's `SECRET_KEY` — becomes undecryptable. **Back up or re-key before upgrading.**
  
  **`@launchfile/macos-dev` — the fix is not retroactive.** Generated secrets persist in `.launchfile/state.json` and are reused, so an existing deployment keeps its old value. This is deliberate (rotating a live secret on upgrade would be worse), but it means an app already deployed with a non-hex secret keeps it until that state is destroyed. This matters for `firefly-iii`, `monica` and `snipe-it`, whose `APP_KEY` is derived through `|base64` and requires exactly 32 bytes — they are broken on existing macos-dev deployments and stay broken until re-provisioned.

- [#275](https://github.com/launchfile/launchfile/pull/275) [`840b643`](https://github.com/launchfile/launchfile/commit/840b64306d5231abff3f20e584ed5b1e0e2dc1f9) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Stable host mappings for every published endpoint, and D-27-correct publication.
  
  - Every endpoint marked `exposed: true` now gets an explicitly allocated host
    port, persisted in state and reused across restarts — previously only a
    component's first endpoint was mapped and the rest were emitted as bare
    container ports, so Docker re-picked them on every recreate.
  - Endpoints that do not set `exposed: true` are no longer published to the
    host (they stay reachable in-network). This matches the spec: `exposed`
    defaults to `false` (D-27). Previously entries that merely omitted `exposed`
    were published on random host ports. For an existing Launchfile that relied
    on that accidental publication, the visible effect of upgrading is that
    those endpoints stop reaching the host until they are marked
    `exposed: true`; the tested catalog apps that need it are updated alongside
    this release.
  - UDP endpoints are published with the `/udp` protocol suffix instead of
    silently as TCP; `bind` applies per endpoint. Host-port availability is
    tracked per wire protocol, so a tcp and a udp endpoint on the same
    container port (a DNS resolver's shape) share one host port and keep it
    across restarts.
  - `launchfile up` / `status` summaries list every published endpoint with a
    protocol-correct address (no more `http://` links to tcp/udp ports), keyed
    by endpoint name (D-6).
  - `$app.*` now derives from the first component with an `exposed: true`
    endpoint, matching its documented contract — for apps whose first
    provides-bearing component was internal (e.g. a database), `$app.url` now
    points at the actual public component. `@launchfile/macos-dev` adopts the
    same rule, so both providers select the same component as the app's public
    address.
  - An app where no endpoint anywhere sets `exposed: true` now warns that
    nothing is published and the app is not reachable, instead of starting
    silently with `$app.url` empty. Individual internal components stay quiet —
    they are the normal shape for a service behind a gateway.

### Patch Changes

- [#226](https://github.com/launchfile/launchfile/pull/226) [`fff0fe0`](https://github.com/launchfile/launchfile/commit/fff0fe0b94ddfe88bc99b7ecd0d25cbc18f19e42) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Declared secrets are redacted regardless of length.
  
  The secret registry dropped any value shorter than `MIN_SECRET_LENGTH` (8). That floor is a heuristic against scrubbing short strings that appear by coincidence, and it is right for values the provider *infers* are secret — everything it mints is far longer, so the floor never binds there.
  
  It was wrong for values something *declared* is a secret. An `env:` literal marked `sensitive: true` (D-18) or a value handed over on the operator channel (D-52) is sensitive because the author or operator said so, not because the provider guessed. A six-digit PIN fell under the floor, was never registered, and reached the on-disk launch-error record in plaintext (CWE-532).
  
  `registerDeclaredSecret` applies no length floor and is what `registerSensitiveEnv` and `registerSuppliedEnv` now use. The empty string is still rejected — an empty separator would splice `[REDACTED]` between every character. `registerSecret` and its floor are unchanged for inferred values.

- [#258](https://github.com/launchfile/launchfile/pull/258) [`f4fcec8`](https://github.com/launchfile/launchfile/commit/f4fcec8c01c6bca3c6e0df664c9bec19d902752b) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - Commands are built as an argument array and run through `execFile`, so a value spliced into a command can no longer be read as shell syntax (CWE-78).
  
  The runtime installers were the live case: `detectVersion()` returns the verbatim contents of `.nvmrc`, `.node-version`, `package.json` engines.node, `.ruby-version` or `.python-version` from the target repo, and `install()` interpolated that string into a command run by `/bin/sh -c`. A repository could therefore run arbitrary commands during `launchfile up` — including under `--no-build`, which skips the app's own `install`/`build` commands but not the runtime install step.
  
  `shell()` now takes `(cmd, args[], opts)`, matching `@launchfile/docker`. Author-written command strings — `commands:`, `health:`, `release:` — keep their shell, which is their documented contract, through the separate `shellScript()` entry point.
  
  Values reused from `.launchfile/state.json` are now validated before they reach SQL. `MysqlProvisioner.provision()` interpolated the stored database name, user and password into `mysql -e`, which runs `;`-separated statements as root; `loadState()` parses that file with no validation and it sits inside the cloned repo. Postgres guarded its two identifiers but not the password. Both provisioners now check all three against `resources/identifiers.ts` before issuing any statement.
  
  Measured, not assumed: the pre-fix postgres password was OS command execution, not a contained role change. Driven against a live server, a hostile `.launchfile/state.json` password inside the `DO $$ … $$` body runs `COPY … TO PROGRAM` (a host command) and escalates the app role to a cluster superuser; only non-transactional DDL such as `DROP DATABASE` is refused inside the block. The base64url password allowlist is what closes this — argv execution alone would still pass a quote through to the SQL parser.
  
  Also fixes an unrelated bug in the same code: the rbenv/pyenv installed-version check matched with `grep`, treating the version as a regex, so every `.` matched any character and an unrelated installed version could satisfy the request and skip the install.
- Updated dependencies [[`c9404d9`](https://github.com/launchfile/launchfile/commit/c9404d9bce10d27fd67d5d74e0667459ea31a1aa), [`19ecdfc`](https://github.com/launchfile/launchfile/commit/19ecdfc864dadf5e436600e2d0637659225bcd47), [`7e8abc5`](https://github.com/launchfile/launchfile/commit/7e8abc56b4479f1f6cf587793004c33265c44f06), [`7e8abc5`](https://github.com/launchfile/launchfile/commit/7e8abc56b4479f1f6cf587793004c33265c44f06)]:
  - @launchfile/sdk@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`6248fad`](https://github.com/launchfile/launchfile/commit/6248fadedb23ef08b4caa2e9bc4b60824ae0abfd)]:
  - @launchfile/sdk@0.3.0

## 0.2.0

### Minor Changes

- [#22](https://github.com/launchfile/launchfile/pull/22) [`b016d5a`](https://github.com/launchfile/launchfile/commit/b016d5afd0761332406ed7aba81828a51fb5e334) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Move capture from the top-level `outputs:` field into a nested `capture:` field on the expanded `commands.*` form, and introduce `commands.bootstrap` as a new lifecycle stage for user-invoked post-start setup. The capture mechanism from D-23 (`pattern` / `description` / `sensitive`) is preserved verbatim — only the placement changes, per D-34's P-10 (source of truth co-located) rationale.

  **Breaking changes:**

  - Removes `outputs?: Record<string, Output>` from the `Launch` and `Component` types and from the corresponding top-level schemas in `LaunchSchema` and `ComponentSchema`.
  - Renames the exported type `OutputSchema` → `CaptureEntrySchema` and the interface `Output` → `CaptureEntry` to match its new role as a reusable capture-entry shape rather than a component-level outputs type.

  Both breaks are legitimate under 0.x semver: zero catalog or example Launchfiles declared `outputs:` at the time of removal, no downstream production usage to preserve, and pre-1.0 is precisely when corrections like this should land cleanly. Launchfiles that previously used `outputs:` should move the block under the command it captures from — e.g. `outputs.admin_password` with the `release` command becomes `commands.release.capture.admin_password`.

  **New features:**

  - `commands.bootstrap` — a new well-known lifecycle stage for user-invoked post-start setup that can only run against a running component (first admin creation, invite link generation, runtime config that depends on `$app.url`). Re-runnable; failures are reported rather than deploy-failing.
  - Nested `capture:` field on any command using the expanded form (`{ command, timeout, capture }`). Available on `release`, `bootstrap`, and any custom command stage.
  - Provider implementations:
    - `@launchfile/macos-dev` exports `launchBootstrap` — runs the command via `spawn({ shell: false })` with argv split, captures stdout, ANSI-strips before matching.
    - `@launchfile/docker` exports `dockerBootstrap` — runs the command via `docker compose exec` with the same safety posture.
  - `launchfile bootstrap [target] [--component <name>]` CLI subcommand that dispatches to the provider-specific implementation.

  See [#16](https://github.com/launchfile/launchfile/issues/16) for the RFC trail and the [DESIGN.md D-34](https://github.com/launchfile/launchfile/blob/main/spec/DESIGN.md#d-34-capture-block-co-located-with-commands-supersedes-d-23-placement) decision record for the full migration rationale.

- [#19](https://github.com/launchfile/launchfile/pull/19) [`11f4bdd`](https://github.com/launchfile/launchfile/commit/11f4bddca847993b12894649e2125187f7bff6cf) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - ## Features

  - **sdk**: `$app.*` resolver context (D-33) — platform-injected app properties (`$app.url`, `$app.host`, `$app.port`) now resolve alongside `$resources` in Launchfile expressions.
  - **sdk**: pipe transforms for encoding (D-32) — secrets and refs can be piped through `|base64`, e.g. `${secrets.app-key|base64}`, required for Laravel-style `APP_KEY` formats.
  - **docker provider**: populates `$app.*` in the resolver context so docker-compose generation can reference app properties (D-33).
  - **macos-dev provider**: populates `$app.*` in the resolver context so local macOS runs can reference app properties (D-33).

  ## Alignment

  All four packages release together at 0.2.0 via the linked group in `.changeset/config.json`. `@launchfile/macos-dev` catches up from 0.1.4 and the CLI advances from 0.1.9. Internal dependency ranges (sdk, docker) are pinned to `^0.2.0` in every consumer.

### Patch Changes

- Updated dependencies [[`b016d5a`](https://github.com/launchfile/launchfile/commit/b016d5afd0761332406ed7aba81828a51fb5e334), [`11f4bdd`](https://github.com/launchfile/launchfile/commit/11f4bddca847993b12894649e2125187f7bff6cf)]:
  - @launchfile/sdk@0.2.0
