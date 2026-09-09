# launchfile

## 0.7.1

### Patch Changes

- [#326](https://github.com/launchfile/launchfile/pull/326) [`3c02b37`](https://github.com/launchfile/launchfile/commit/3c02b377e610e92660d2fc70534d29c66116efa6) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Stop compiling and publishing tests with the CLI. `packages/launchfile` built with plain `tsc`, so `src/__tests__/*.test.ts` landed in `dist/` and — via the `dist/**/*.js` files allowlist — in the npm tarball: 20 of `launchfile@0.7.0`'s 54 published files are compiled test artifacts. That same `dist/__tests__` tree also made Vitest collect every suite twice (20 test files instead of 10), doubling the work each CI run does. The package now builds with a `tsconfig.build.json` that excludes `src/**/__tests__/**` — byte-for-byte the config `@launchfile/docker` and `@launchfile/macos-dev` use, while `@launchfile/sdk` and `@launchfile/aws` build the same way with their own exclude lists. No runtime behavior changes.
- Updated dependencies [[`d0774c0`](https://github.com/launchfile/launchfile/commit/d0774c05785c2b09138849ff1c9b55325b94e960)]:
  - @launchfile/docker@0.7.1

## 0.7.0

### Minor Changes

- [#315](https://github.com/launchfile/launchfile/pull/315) [`78e654d`](https://github.com/launchfile/launchfile/commit/78e654dee040d6eb2e1aa18bb850b219de777996) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `@launchfile/macos-dev` implements the D-50 operator-supplied storage channel ([#296](https://github.com/launchfile/launchfile/issues/296)), the last of the three surfaces D-50's conformance paragraph named. `provisionStorage` previously `mkdir`ed every declared volume and never read `volume.content`, so a `storage.<name>.content: operator` volume was created empty and the app started against it — the silent success the marker exists to catch.
  
  **`launchfile up --native --storage <volume>=<path>` now works** where it previously exited with "not yet supported". All four D-50 states hold: a supplied path becomes the volume's path, a marked volume with no path fails the launch naming the flag that satisfies it, a supplied path that is absent or unreadable fails the launch and is never created, and an unmarked volume keeps its `.launchfile/storage/<component>/<name>` path byte-for-byte. Because this provider runs processes on the host, the grant is the path injected as `$storage.<name>.path` (D-39) rather than a mount. The refusal lands before state, directories, resources, ports, runtimes or processes exist, so `--dry-run` refuses too. `launchfile env` reports the bound path from provider state, not a `.launchfile/` path the app never read.
  
  **A Launchfile with a `content: operator` volume that ran under the native provider before now fails until its paths are supplied.** That is the point of the change: what those runs produced was an empty directory standing in for the operator's content.
  
  `@launchfile/sdk` gains `indexOperatorStoragePaths` — D-50 rule 1's key rule, previously implemented separately in the docker provider and the catalog harness — along with `UnboundOperatorStorageError`, `MissingOperatorStoragePathError`, `StorageBind` and `UnboundOperatorVolume`, moved from `@launchfile/docker` so one caller-side catch covers every provider that raises them.
  
  `@launchfile/docker` reads both from the SDK instead of defining them. Its public API, refusal messages, warning text and generated compose are unchanged.

### Patch Changes

- Updated dependencies [[`78e654d`](https://github.com/launchfile/launchfile/commit/78e654dee040d6eb2e1aa18bb850b219de777996), [`0a94497`](https://github.com/launchfile/launchfile/commit/0a9449773fb5efca4f1c90ea647785de76354beb)]:
  - @launchfile/sdk@0.7.0
  - @launchfile/docker@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [[`b6e6e09`](https://github.com/launchfile/launchfile/commit/b6e6e099ecaee591207a7cb5981a3d07ed171875)]:
  - @launchfile/docker@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [[`e25c4dc`](https://github.com/launchfile/launchfile/commit/e25c4dcdcd1dc067c897d2e7a446e9b6bf731578)]:
  - @launchfile/docker@0.5.0

## 0.4.0

### Minor Changes

- [#193](https://github.com/launchfile/launchfile/pull/193) [`c9404d9`](https://github.com/launchfile/launchfile/commit/c9404d9bce10d27fd67d5d74e0667459ea31a1aa) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Lifecycle failure semantics + duration grammar (D-48). `validate` now warns on any duration outside the ratified grammar `^(\d+)(ms|s|m|h)$` (`commands.*.timeout`, `health.interval`/`timeout`/`start_period`); the SDK exports `parseDurationMs`/`isValidDuration`/`lintDurations`. The docker provider now executes a declared `release` before `start` as a one-shot `docker compose run --rm` (resources ready first via `depends_on`) and fails the deploy on error. Both providers surface an unparseable duration instead of silently substituting a 120s default: release/prepare fail the deploy/launch, bootstrap reports the failure.
  
  **Release commands now run in a shell.** `@launchfile/docker` previously split a release command on whitespace and executed the first token directly, so `release: "a && b"` ran only `a` and passed `&&` along as a literal argument. The command is now handed to `sh -c` inside the one-shot container, matching `@launchfile/macos-dev` and SPEC.md § Command interpretation. This requires a shell in the image; a release on a distroless or scratch image now fails with a surfaced `sh: not found` rather than silently running part of the command.

- [#287](https://github.com/launchfile/launchfile/pull/287) [`7e8abc5`](https://github.com/launchfile/launchfile/commit/7e8abc56b4479f1f6cf587793004c33265c44f06) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `--name <label>` isolates a deployment (D-55). An unnamed `up` and each `--name <label>` from the same source are now distinct deployment instances: the effective slug becomes `<base>-<label>` and keys the state directory, compose project, network, volumes, and persisted host ports, so two instances of one app never share or clobber each other's state. The deployment index is keyed by (source, name), and a bare `down`/`status`/`logs` that matches more than one instance lists them instead of guessing. `--name` requires a value, and the macOS native provider refuses the flag rather than pretending to isolate.
  
  **Behavior change:** an `up` that finds existing state recorded from a *different* source (any source type) now refuses to adopt it, with the remedies in the message — previously it silently adopted or clobbered the same-named stack. Re-running `up` from the same source is unaffected.
  
  Also fixes [#248](https://github.com/launchfile/launchfile/issues/248): CLI flag parsing no longer consumes a value flag's argument as the positional target, so `launchfile up --name blue` no longer treats `blue` as the app to deploy.

- [#226](https://github.com/launchfile/launchfile/pull/226) [`19ecdfc`](https://github.com/launchfile/launchfile/commit/19ecdfc864dadf5e436600e2d0637659225bcd47) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Structured launch failures and `launchfile diagnose` ([#44](https://github.com/launchfile/launchfile/issues/44)). The SDK gains the shared failure vocabulary every provider reports through — `LaunchError`, `LaunchErrorContext`, the slot-keyed `LaunchPhase`/`LaunchSlot` enums, `dispositionForPhase` (the D-48 failure table), `slotForCommand`/`commandForSlot`, `buildLaunchErrorContext`, and the text-sanitizing helpers — all pure, with no I/O. `@launchfile/docker` captures a failing launch into that shape and redacts it at capture, inside the process that still holds the secret registry; it also registers author-declared `sensitive: true` values (D-18) and operator-supplied `required:` values (D-52) before anything is captured, and exports `dockerLaunchError`, `dockerErrorKey`, `declaredEnvKeys`, `registerSensitiveEnv`, and `registerSuppliedEnv`. The CLI persists one record per app at `~/.launchfile/errors/<key>.json` (mode `0600`, in a `0700` directory) and adds **`launchfile diagnose [id|slug]`**, with `--json`, to show why the last launch failed. A record is superseded by the next successful `up` and removed by `down --destroy`. Only env var *names* are ever stored — the record has no field a value can land in.
  
  **`launchfile up` now exits non-zero when a component never becomes healthy.** SPEC.md § Failure semantics has always said that a component which never becomes healthy fails the invocation; `@launchfile/docker` reported the 120s timeout as a warning and returned success anyway. It now fails, naming the components that never passed. A script that treated a slow-to-healthy app as a successful deploy will start seeing a non-zero exit — fix the app's health check, or read `launchfile diagnose`, which reports `phase: health`. A component that declares no health check is unaffected: it counts as healthy once its container is running. The 120s budget itself is unchanged.
  
  **A failed launch that started containers now appears in `launchfile list`.** The deployment index records what exists on the machine, not what succeeded. A health-gate failure is registered with status `unhealthy` — its containers are deliberately left running for inspection — and a `release` or `run` failure with status `unknown`, so `launchfile status`, `logs`, and `down` all reach a deployment that failed to come up, including via the `launchfile status / launchfile logs` the health failure prints. Failures refused before any container exists — `prereq`, `resolve`, `parse`, `provision`, `prepare` — still leave no entry.

- [#287](https://github.com/launchfile/launchfile/pull/287) [`7e8abc5`](https://github.com/launchfile/launchfile/commit/7e8abc56b4479f1f6cf587793004c33265c44f06) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - The D-50 operator-storage channel: repeatable `--storage <volume>=<path>` (and `<component>.<volume>=<path>` when the name is ambiguous) hands a `content: operator` volume its host content at `up` time. `@launchfile/docker` binds the supplied path into the volume, or refuses loudly: a marked volume with no supplied path, or a supplied path that is absent or unreadable on the host, stops the launch before anything starts — the provider never papers over a missing supply by creating an empty volume (D-52's fabrication rule, in storage form). The macOS native provider refuses `--storage`.
  
  **Behavior change:** a Launchfile carrying `content: operator` now refuses to `up` without a supplied path. The marker did not exist before this release, so no existing Launchfile is affected.

### Patch Changes

- Updated dependencies [[`fff0fe0`](https://github.com/launchfile/launchfile/commit/fff0fe0b94ddfe88bc99b7ecd0d25cbc18f19e42), [`7cc2bdb`](https://github.com/launchfile/launchfile/commit/7cc2bdbeb4efab65fa5bb613aa440195c84ec5ac), [`c9404d9`](https://github.com/launchfile/launchfile/commit/c9404d9bce10d27fd67d5d74e0667459ea31a1aa), [`7e8abc5`](https://github.com/launchfile/launchfile/commit/7e8abc56b4479f1f6cf587793004c33265c44f06), [`19ecdfc`](https://github.com/launchfile/launchfile/commit/19ecdfc864dadf5e436600e2d0637659225bcd47), [`7e8abc5`](https://github.com/launchfile/launchfile/commit/7e8abc56b4479f1f6cf587793004c33265c44f06), [`7e8abc5`](https://github.com/launchfile/launchfile/commit/7e8abc56b4479f1f6cf587793004c33265c44f06), [`840b643`](https://github.com/launchfile/launchfile/commit/840b64306d5231abff3f20e584ed5b1e0e2dc1f9), [`7e8abc5`](https://github.com/launchfile/launchfile/commit/7e8abc56b4479f1f6cf587793004c33265c44f06)]:
  - @launchfile/docker@0.4.0
  - @launchfile/sdk@0.4.0

## 0.3.0

### Minor Changes

- [#115](https://github.com/launchfile/launchfile/pull/115) [`6248fad`](https://github.com/launchfile/launchfile/commit/6248fadedb23ef08b4caa2e9bc4b60824ae0abfd) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - Resolve `$app.url` (and the rest of the `$app.*` set) on the public `npx launchfile up` path. An app that references its own public URL — e.g. `$app.url` in an `env` value — now resolves correctly when launched via the Docker provider, not only in local dev.

### Patch Changes

- Updated dependencies [[`6248fad`](https://github.com/launchfile/launchfile/commit/6248fadedb23ef08b4caa2e9bc4b60824ae0abfd)]:
  - @launchfile/sdk@0.3.0
  - @launchfile/docker@0.3.0

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

### Patch Changes

- [#19](https://github.com/launchfile/launchfile/pull/19) [`11f4bdd`](https://github.com/launchfile/launchfile/commit/11f4bddca847993b12894649e2125187f7bff6cf) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - ## Features

  - **sdk**: `$app.*` resolver context (D-33) — platform-injected app properties (`$app.url`, `$app.host`, `$app.port`) now resolve alongside `$resources` in Launchfile expressions.
  - **sdk**: pipe transforms for encoding (D-32) — secrets and refs can be piped through `|base64`, e.g. `${secrets.app-key|base64}`, required for Laravel-style `APP_KEY` formats.
  - **docker provider**: populates `$app.*` in the resolver context so docker-compose generation can reference app properties (D-33).
  - **macos-dev provider**: populates `$app.*` in the resolver context so local macOS runs can reference app properties (D-33).

  ## Alignment

  All four packages release together at 0.2.0 via the linked group in `.changeset/config.json`. `@launchfile/macos-dev` catches up from 0.1.4 and the CLI advances from 0.1.9. Internal dependency ranges (sdk, docker) are pinned to `^0.2.0` in every consumer.

- Updated dependencies [[`b016d5a`](https://github.com/launchfile/launchfile/commit/b016d5afd0761332406ed7aba81828a51fb5e334), [`11f4bdd`](https://github.com/launchfile/launchfile/commit/11f4bddca847993b12894649e2125187f7bff6cf)]:
  - @launchfile/sdk@0.2.0
  - @launchfile/docker@0.2.0

## 0.1.9

### Patch Changes

- [`cfc48c1`](https://github.com/launchfile/launchfile/commit/cfc48c1f2ace3074c14252127b44f9c3b2f93a55) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Fixed missing dist/ in published package — CLI binary was not included in 0.1.8.

## 0.1.8

### Patch Changes

- [`ab08260`](https://github.com/launchfile/launchfile/commit/ab08260f963ebc44a54148398b8992b63919dbda) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Added SDK public API re-exports to the `launchfile` package so `import { readLaunch, LaunchSchema } from "launchfile"` works as documented. CLI version is now read from package.json automatically.

  Docker provider now resolves catalog slugs from the local directory during development, falling back to GitHub when published.

- Updated dependencies [[`ab08260`](https://github.com/launchfile/launchfile/commit/ab08260f963ebc44a54148398b8992b63919dbda), [`ab08260`](https://github.com/launchfile/launchfile/commit/ab08260f963ebc44a54148398b8992b63919dbda)]:
  - @launchfile/sdk@0.1.8
  - @launchfile/docker@0.1.8
