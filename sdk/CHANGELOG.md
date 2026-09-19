# @launchfile/sdk

## 0.10.0

### Minor Changes

- [#488](https://github.com/launchfile/launchfile/pull/488) [`ab3e359`](https://github.com/launchfile/launchfile/commit/ab3e359e70f00fe9758855b33cc99506e1736dc2) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `$app.endpoints.<name>.{url, host, port, scheme, authority, tls}` — a public address for every named published endpoint ([#463](https://github.com/launchfile/launchfile/issues/463), D-63).
  
  The resolver gains one nested form under the reserved `$app.*` prefix. It reads a sibling field, `ResolverContext.appEndpoints`, keyed by `provides[].name`, never a map inside `context.app`; only the four-segment form addresses a value, and every other shape — no name, no property, an unknown name or property, an endpoint the provider registered nothing for — resolves `""` (L-4). `AppEndpointProperties`, `APP_ENDPOINT_PROPERTIES` and `UNPUBLISHED_APP_ENDPOINT` (the all-`""` answer a provider registers when it publishes no per-endpoint address) are exported.
  
  `validate` warns on each reference that resolves `""`: `$app.endpoints` with no name, `$app.endpoints.<name>` with no property, a name no `provides` entry carries, a named endpoint that is not `exposed: true`, and a property outside the six. `appEndpointReferences(launch)` lists a file's references so providers can name the endpoints an app asks for.
  
  One new validation error: a `provides[].name` declared on two components is refused naming both — an endpoint name is app-wide now that `$app.endpoints.<name>.*` addresses it by name alone. No tracked catalog Launchfile declares one, so nothing that validates today starts failing.

- [#343](https://github.com/launchfile/launchfile/pull/343) [`31dbac2`](https://github.com/launchfile/launchfile/commit/31dbac2a4c58dc50c4d4959facf6ff0b3aefa1e3) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `lintLaunch` now warns on a bare `$prop` reference inside an `env:` value ([#184](https://github.com/launchfile/launchfile/issues/184)). `env:` is evaluated with no resource in context, so `$host`/`${port:-5432}`-style references written there can never resolve against a resource the way the same syntax does in `set_env:` — they always fall through to their `:-default` fallback, or to an empty string when they have none, regardless of spelling. The check shares the `bareReferences()` helper already used by the D-46 known-property-vocabulary check, stays warn-only, and touches neither the resolver nor validation's `valid`/exit-code outcome. Command-string references (`commands.*.command`) fail the same way but are tracked separately in [#227](https://github.com/launchfile/launchfile/issues/227).

- [#354](https://github.com/launchfile/launchfile/pull/354) [`1123da3`](https://github.com/launchfile/launchfile/commit/1123da37959a0fbebca27c112ed6e8ebd8dc0bff) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - macos-dev gains the orchestrator-facing publication channel (D-58)
  
  `launchUp({ appUrl })` supplies the public URL of the app's primary endpoint
  when routing is owned upstream, and `$app.*` resolves from it instead of
  `http://localhost:<port>`. The value is persisted in `.launchfile/state.json`,
  so `env` and `bootstrap` answer with it and a later run that omits the option
  keeps it; supplying a different one replaces it.
  
  `https-origin` (D-60) rides that channel, as it does under `@launchfile/docker`:
  an `https` `appUrl` satisfies a required entry and resolves its `url` to
  `$app.url`; with no URL, or one whose scheme is not `https`, the component is
  refused with the same two reasons docker gives. A declared `https-origin`
  entry also names the app's primary endpoint for `$app.*` (D-60 rule 3).
  
  The SDK now owns D-58's URL contract — `normalizeAppUrl`, `InvalidAppUrlError`,
  `suppliedAppAddress`, and `suppliedAppProperties` — so both providers refuse a
  malformed value with the same message instead of carrying two copies of a spec
  rule. `@launchfile/docker` re-exports the first two and its `publishedAddress`
  derives a supplied URL through `suppliedAppAddress`, so its public API is
  unchanged.

- [#519](https://github.com/launchfile/launchfile/pull/519) [`d2039b2`](https://github.com/launchfile/launchfile/commit/d2039b22ce1ed3fb5fc2fb7f2cb427d3582e4269) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Added named repeatable uses ([#516](https://github.com/launchfile/launchfile/issues/516), SPEC.md § Resource uses): a use the vocabulary marks repeatable (`db` on redis, `database` on postgres and mysql) may occur more than once on one entry, each occurrence a single-key map naming it — `uses: [{db: cache}, {db: sessions}, pubsub]` — and addressed as `$<resource>.<use>.<name>.<property>` (`$redis.db.cache.url`, `$redis.db.sessions.index`). `readLaunch` rejects the same name twice on one token, a token declared both bare and named on one entry, a map naming two uses in one item, and a name on a non-repeatable use (`pubsub`, `server`); `writeLaunch` round-trips the map form. `Requirement.uses` is now `UseDeclaration[]` (`string | Record<string, string>`); `declaredUse`, `useKey`, `useKeys`, `parseUseKey` and `formatUseKey` decode it, and `isRepeatableUse` reports the registry's Repeatable column. `ResolverContext.uses` lists use keys (`db`, `db.cache`): on an entry that names its `db` uses, `$redis.db.url` and `$redis.db.nosuch.url` throw `UnresolvedUseError` — never the instance url. `lintLaunch` checks the token of a named use and treats `db` and `db: cache` as divergent across same-name entries.

- [#515](https://github.com/launchfile/launchfile/pull/515) [`1796de9`](https://github.com/launchfile/launchfile/commit/1796de9ae8d42f920cca6a4326de9e2ed981fe2f) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Added `uses` on `requires`/`supports` entries ([#509](https://github.com/launchfile/launchfile/issues/509), SPEC.md § Resource uses): a list declaring which features of the resource the app uses — `db`, `pubsub`, `server` for redis; `database`, `server` for postgres and mysql. Undeclared keeps today's meaning (what the property vocabulary promises); a declared use registers its own `$<resource>.<use>.<property>` fields (`$redis.db.url` is `redis://host:port/<index>`, `$redis.db.index` the integer). The field round-trips through `readLaunch`/`writeLaunch`, is rejected on a host-capability entry, and is published under `$defs/requirement` of the JSON Schema. The use vocabulary ships under the `uses` key of `schema/resource-properties.json` and as `RESOURCE_USE_VOCABULARY`; `lintLaunch` warns on a token outside it (open vocabulary, never a validation error) and on same-name entries whose `uses` diverge.
  
  Changed expression resolution for a resource whose entry declares `uses`: a `$<resource>.<use>.<property>` path resolves from that use's registered properties (`ResolverContext.uses` names the declaring resources) or throws `UnresolvedUseError` — the last-segment fallback, which hands `$redis.db.url` the plain instance URL today, no longer applies to such a resource. Resources that declare no `uses` keep the fallback unchanged; the general fallback is tracked separately in [#514](https://github.com/launchfile/launchfile/issues/514).

- [#394](https://github.com/launchfile/launchfile/pull/394) [`a399ba3`](https://github.com/launchfile/launchfile/commit/a399ba365a2c7a3fe3b349d43810d3ff329e77c2) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Sanitize file-derived text at `validate`'s diagnostic boundaries. Every lint warning (`checkResourceProperties`, the unknown-storage-key check, D-24/D-40/D-43/D-44/D-50 checks) embeds strings taken verbatim from the parsed Launchfile — resource types, storage keys, component names — and so do the `host capabilities requested:` and `operator-supplied storage:` summary lines `validate` prints. A crafted key containing a newline or an ANSI escape sequence could inject a spoofed line or terminal control codes into that output (CWE-117) when validating an untrusted third-party Launchfile.
  
  `sdk/src/errors.ts` now exports `stripControlInline`, applied where lint warnings are joined into `ValidateResult.warnings`, at every file-derived value `cmdValidate` prints (`name`, `components`, `requires`, `host capabilities requested:`, `operator-supplied storage:`, and each `deprecated:` line's path), and on the validation-failure lines `formatZodErrors` builds from a Zod issue path — a component name is an unconstrained map key, so it reaches the error path verbatim. It builds on the existing `stripControl` (ANSI-escape and control-character stripping) and additionally escapes any embedded backslash, tab or newline into its visible two-character form, so a diagnostic that must render as one line always does and a reader can tell a real newline from the two characters `\n` — `stripControl` alone keeps `\t`/`\n` literal, which is correct for its own multi-line command-output-tail use but not for a single-line diagnostic.
  
  `formatZodErrors`'s other two branches go through `stripControl` instead. A `yaml` parse error quotes the offending source line verbatim (the library's `prettyErrors` default), so a syntax error in a hostile file put that file's own bytes — ANSI escapes included — into the same `console.error` loop, in `cmdInspect` as well as `cmdValidate`. That quoted snippet is legitimately multi-line, so escapes and control characters go while the `\n`/`\t` laying out the caret stay.
  
  `ValidateResult` now documents where the boundary sits: `warnings` and `errors` are sanitized diagnostics, while `name`, `components`, `requires`, `hostCapabilities`, `operatorStorage` and `deprecations[].path` hold the document's strings verbatim for programmatic callers, which sanitize themselves before printing. No behavior change for any well-formed document.

### Patch Changes

- [#420](https://github.com/launchfile/launchfile/pull/420) [`f40e7b6`](https://github.com/launchfile/launchfile/commit/f40e7b68d99f61d777455f0f79e4ab94d2cf1519) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Fix `example` field on environment variables (D-31) being silently dropped by `readLaunch`/`writeLaunch`. `EnvVarObjectSchema`, the `EnvVar`/`NormalizedEnvVar` types, and the reader/writer normalization now carry `example` through parse and serialize, matching the published JSON Schema.

- [#341](https://github.com/launchfile/launchfile/pull/341) [`3587317`](https://github.com/launchfile/launchfile/commit/35873173251a6a8e9f97d5fae592fa7fd998bf7d) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Fix D-25 field inheritance: `normalizeComponent` only applied the `?? defaults?.` fallback to 7 of the 17 fields a component can carry (`runtime`, `image`, `build`, `source`, `restart`, `platform`, `host`). The other 10 — `provides`, `requires`, `supports`, `env`, `commands`, `health`, `depends_on`, `storage`, `schedule`, `singleton` — took the component's own value with no fallback, so a top-level value was silently discarded on parse whenever a `components:` block was also present, with no diagnostic. All 17 fields now inherit consistently: a component that omits one of these fields inherits the top-level default, and a component that declares its own value (including an empty one) takes it whole, per D-25's whole-value-replacement rule. Parse output changes for any Launchfile that pairs a top-level value in one of the 10 fields with a `components:` block — 0 of 113 shipped catalog Launchfiles use that shape today.

- [#342](https://github.com/launchfile/launchfile/pull/342) [`39df9db`](https://github.com/launchfile/launchfile/commit/39df9db10c64b7fded71e9afd74c08c7a8614285) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Resolve inherited `Object.prototype` keys to empty string instead of the inherited value. Every context record the resolver indexes (`$app.*`, `$secrets.*`, `$components.*`, `$storage.*`, bare `$prop`, `$resource.prop`) is a plain object supplied by a caller, so a reference spelled `constructor`, `__proto__`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf` or `propertyIsEnumerable` returned the inherited member and stringified it into the env var — `$app.constructor` became `"function Object() { [native code] }"`, `$storage.constructor.name` became `"Object"`. `spec/DESIGN.md` requires unknown properties to degrade to empty string (D-33, D-39, L-4); D-46 calls that fallback load-bearing for forward compatibility. Each lookup is now guarded with `Object.hasOwn`, in the name position as well as the property position, so a miss falls through to the caller's `""` or `:-default` fallback. The `$secrets.*` branch also gained the `String(val)` coercion its siblings already had — it was the one branch that could return a non-string from a function typed `string | undefined`. A property genuinely spelled like a prototype key still resolves: the guard only rejects keys the object does not own.

## 0.9.0

### Minor Changes

- [#484](https://github.com/launchfile/launchfile/pull/484) [`b5022ae`](https://github.com/launchfile/launchfile/commit/b5022aed608e2ccd65857fb9a045337faeb94830) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `formatCaptures(captures, captureMeta, reveal)` — the one display formatter for a command's captures ([#464](https://github.com/launchfile/launchfile/issues/464)).
  
  A capture declared `sensitive: true` prints as `***` on every display surface unless `reveal` is true, and a masked list ends with one hint line naming `launchfile bootstrap --reveal`. Non-sensitive captures print the same either way. `sensitiveCaptureValues` returns the values a provider must register with its redactor. The SDK returns lines; the provider prints them. `CAPTURE_MASK` and `REVEAL_HINT` are exported so tests and providers agree on the text.

## 0.8.0

### Minor Changes

- [#468](https://github.com/launchfile/launchfile/pull/468) [`fc92434`](https://github.com/launchfile/launchfile/commit/fc9243433293ac0c2061d25f6c83b352985c023f) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Add the `tls:` certificate binding: a `provides` entry can name one `supports:` entry of type `certificate` on the same component, and while that binding is active the entry's **effective** listener protocol is `https` (D-61).
  
  `tls: server-cert` is shorthand for `tls: { certificate: server-cert }`; both spellings parse, normalize and serialize, and are mirrored in `spec/schema/launchfile.schema.json`. The object form is strict — an unknown key inside it is an error, because a binding-level `port:` override is Left open and strip mode would accept one and silently drop it.
  
  Five cross-field rules are hard validation errors, none of them visible per entry:
  
  - the bound `provides` entry declares an HTTP-family listener (`http`, `https`, `ws`, `grpc`) — `tls:` on a `tcp` or `udp` entry is rejected, naming the entry and its protocol, on the family line D-60 rule 2 draws for `https-origin`;
  - the named certificate exists in the **same component's** `supports:`;
  - that entry declares `type: certificate`;
  - no certificate is bound by two `provides` entries;
  - a binding naming a `requires:` entry is rejected as out of scope, with a message pointing at the follow-up.
  
  New API: `effectiveListener(entry, activeCertificates)` returns the declared and effective protocol/port for one `provides` entry — one definition, so validation and tooling read the declared value while every URL-emitting expression reads the effective one. `boundCertificate`, `certificateBindings` and the `CERTIFICATE` type constant come with it.
  
  The registry gains `certificate: { cert_file, key_file }` — two app-filesystem paths and no address. `key_file` is credential-bearing whatever its vocabulary membership.
  
  Every file that declares no `tls:` parses, validates and serializes exactly as before.

- [#465](https://github.com/launchfile/launchfile/pull/465) [`dc8a759`](https://github.com/launchfile/launchfile/commit/dc8a75968f56be9811d9feda38ceb640e453be9b) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Add the `https-origin` backing-service type: an app can declare that browsers must reach it at a public origin whose scheme is `https` (D-60).
  
  A `requires`/`supports` entry of that type carries a new optional field, `endpoint`, naming the `provides` entry the origin fronts by its `name` (D-6). The field is parsed, normalized and serialized, so it survives a parse → serialize round trip, and is mirrored in `spec/schema/launchfile.schema.json`.
  
  Two cross-field rules are hard validation errors, because neither can be seen per entry and a silently skipped declaration is the failure the type exists to remove:
  
  - **Rule 2** — `endpoint` is required on an `https-origin` entry and rejected on any other type. The entry must sit on the component that owns the endpoint (top level in a file that declares `components:` is an error), the name must match exactly one `provides` entry on that component, and that entry must be `exposed: true` with an HTTP-family listener — `http`, `https`, `ws`, or `grpc`. Naming a `tcp` or `udp` entry fails, quoting the endpoint and its protocol.
  - **Rule 3** — an app declares at most one `https-origin` entry.
  
  The registry gains `https-origin: { url }` — one property, the public origin, the same string `$app.url` resolves to.
  
  Every file that declares no `https-origin` entry parses, validates and serializes exactly as before.

## 0.7.0

### Minor Changes

- [#315](https://github.com/launchfile/launchfile/pull/315) [`78e654d`](https://github.com/launchfile/launchfile/commit/78e654dee040d6eb2e1aa18bb850b219de777996) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `@launchfile/macos-dev` implements the D-50 operator-supplied storage channel ([#296](https://github.com/launchfile/launchfile/issues/296)), the last of the three surfaces D-50's conformance paragraph named. `provisionStorage` previously `mkdir`ed every declared volume and never read `volume.content`, so a `storage.<name>.content: operator` volume was created empty and the app started against it — the silent success the marker exists to catch.
  
  **`launchfile up --native --storage <volume>=<path>` now works** where it previously exited with "not yet supported". All four D-50 states hold: a supplied path becomes the volume's path, a marked volume with no path fails the launch naming the flag that satisfies it, a supplied path that is absent or unreadable fails the launch and is never created, and an unmarked volume keeps its `.launchfile/storage/<component>/<name>` path byte-for-byte. Because this provider runs processes on the host, the grant is the path injected as `$storage.<name>.path` (D-39) rather than a mount. The refusal lands before state, directories, resources, ports, runtimes or processes exist, so `--dry-run` refuses too. `launchfile env` reports the bound path from provider state, not a `.launchfile/` path the app never read.
  
  **A Launchfile with a `content: operator` volume that ran under the native provider before now fails until its paths are supplied.** That is the point of the change: what those runs produced was an empty directory standing in for the operator's content.
  
  `@launchfile/sdk` gains `indexOperatorStoragePaths` — D-50 rule 1's key rule, previously implemented separately in the docker provider and the catalog harness — along with `UnboundOperatorStorageError`, `MissingOperatorStoragePathError`, `StorageBind` and `UnboundOperatorVolume`, moved from `@launchfile/docker` so one caller-side catch covers every provider that raises them.
  
  `@launchfile/docker` reads both from the SDK instead of defining them. Its public API, refusal messages, warning text and generated compose are unchanged.

## 0.4.0

### Minor Changes

- [#193](https://github.com/launchfile/launchfile/pull/193) [`c9404d9`](https://github.com/launchfile/launchfile/commit/c9404d9bce10d27fd67d5d74e0667459ea31a1aa) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Lifecycle failure semantics + duration grammar (D-48). `validate` now warns on any duration outside the ratified grammar `^(\d+)(ms|s|m|h)$` (`commands.*.timeout`, `health.interval`/`timeout`/`start_period`); the SDK exports `parseDurationMs`/`isValidDuration`/`lintDurations`. The docker provider now executes a declared `release` before `start` as a one-shot `docker compose run --rm` (resources ready first via `depends_on`) and fails the deploy on error. Both providers surface an unparseable duration instead of silently substituting a 120s default: release/prepare fail the deploy/launch, bootstrap reports the failure.
  
  **Release commands now run in a shell.** `@launchfile/docker` previously split a release command on whitespace and executed the first token directly, so `release: "a && b"` ran only `a` and passed `&&` along as a literal argument. The command is now handed to `sh -c` inside the one-shot container, matching `@launchfile/macos-dev` and SPEC.md § Command interpretation. This requires a shell in the image; a release on a distroless or scratch image now fails with a surfaced `sh: not found` rather than silently running part of the command.

- [#226](https://github.com/launchfile/launchfile/pull/226) [`19ecdfc`](https://github.com/launchfile/launchfile/commit/19ecdfc864dadf5e436600e2d0637659225bcd47) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Structured launch failures and `launchfile diagnose` ([#44](https://github.com/launchfile/launchfile/issues/44)). The SDK gains the shared failure vocabulary every provider reports through — `LaunchError`, `LaunchErrorContext`, the slot-keyed `LaunchPhase`/`LaunchSlot` enums, `dispositionForPhase` (the D-48 failure table), `slotForCommand`/`commandForSlot`, `buildLaunchErrorContext`, and the text-sanitizing helpers — all pure, with no I/O. `@launchfile/docker` captures a failing launch into that shape and redacts it at capture, inside the process that still holds the secret registry; it also registers author-declared `sensitive: true` values (D-18) and operator-supplied `required:` values (D-52) before anything is captured, and exports `dockerLaunchError`, `dockerErrorKey`, `declaredEnvKeys`, `registerSensitiveEnv`, and `registerSuppliedEnv`. The CLI persists one record per app at `~/.launchfile/errors/<key>.json` (mode `0600`, in a `0700` directory) and adds **`launchfile diagnose [id|slug]`**, with `--json`, to show why the last launch failed. A record is superseded by the next successful `up` and removed by `down --destroy`. Only env var *names* are ever stored — the record has no field a value can land in.
  
  **`launchfile up` now exits non-zero when a component never becomes healthy.** SPEC.md § Failure semantics has always said that a component which never becomes healthy fails the invocation; `@launchfile/docker` reported the 120s timeout as a warning and returned success anyway. It now fails, naming the components that never passed. A script that treated a slow-to-healthy app as a successful deploy will start seeing a non-zero exit — fix the app's health check, or read `launchfile diagnose`, which reports `phase: health`. A component that declares no health check is unaffected: it counts as healthy once its container is running. The 120s budget itself is unchanged.
  
  **A failed launch that started containers now appears in `launchfile list`.** The deployment index records what exists on the machine, not what succeeded. A health-gate failure is registered with status `unhealthy` — its containers are deliberately left running for inspection — and a `release` or `run` failure with status `unknown`, so `launchfile status`, `logs`, and `down` all reach a deployment that failed to come up, including via the `launchfile status / launchfile logs` the health failure prints. Failures refused before any container exists — `prereq`, `resolve`, `parse`, `provision`, `prepare` — still leave no entry.

- [#287](https://github.com/launchfile/launchfile/pull/287) [`7e8abc5`](https://github.com/launchfile/launchfile/commit/7e8abc56b4479f1f6cf587793004c33265c44f06) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - The D-50 `content: operator` storage marker. The SDK parses, round-trips, and serializes `content: operator` on a storage entry — the author's declaration that a volume's content is supplied by the operator at deploy time, not created empty by the provider — and rejects any other `content:` value. `launchfile validate` lists operator-supplied volumes in its privilege summary (an `operator-supplied storage:` line, `operatorStorage` in `--json`), so the marker is visible before anything runs. A new advisory lint warns when `persistent: false` sits beside the marker — operator-supplied content on a non-persistent volume is almost certainly a mistake.

- [#287](https://github.com/launchfile/launchfile/pull/287) [`7e8abc5`](https://github.com/launchfile/launchfile/commit/7e8abc56b4479f1f6cf587793004c33265c44f06) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `launchfile validate` warns when a storage entry carries keys the schema does not recognize ([#239](https://github.com/launchfile/launchfile/issues/239)). Zod's default strip meant a typo like `persistant:` or a key from a newer spec vocabulary vanished silently — the entry validated, the intent was lost. The check runs on the raw document before parsing, names the unrecognized keys, and lists the known set so the fix is in the message. Warn-only per D-46's unknown-vocabulary posture: the exit code is unchanged, so no existing Launchfile starts failing validation.

## 0.3.0

### Minor Changes

- [#115](https://github.com/launchfile/launchfile/pull/115) [`6248fad`](https://github.com/launchfile/launchfile/commit/6248fadedb23ef08b4caa2e9bc4b60824ae0abfd) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - Resolve `$app.url` (and the rest of the `$app.*` set) on the public `npx launchfile up` path. An app that references its own public URL — e.g. `$app.url` in an `env` value — now resolves correctly when launched via the Docker provider, not only in local dev.

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

## 0.1.10

### Patch Changes

- [`d0298ba`](https://github.com/launchfile/launchfile/commit/d0298ba3e630087613e9b6a2ce63e0ba649f9d7d) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Fixed missing dist/ in Docker provider and SDK packages published in 0.1.8.

## 0.1.8

### Patch Changes

- [`ab08260`](https://github.com/launchfile/launchfile/commit/ab08260f963ebc44a54148398b8992b63919dbda) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Removed `bin` entry from SDK package. The CLI binary now lives exclusively in the `launchfile` package — the SDK's leftover `bin` field was shadowing it, causing `npx launchfile up` to run the old SDK CLI instead.
