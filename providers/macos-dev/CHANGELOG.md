# @launchfile/macos-dev

## 0.15.0

### Minor Changes

- [#703](https://github.com/launchfile/launchfile/pull/703) [`a301faf`](https://github.com/launchfile/launchfile/commit/a301faf38151e7505952277a00c79949ade6d5d8) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - `launchfile up --native --detach` and `launchfile dev --detach` now return once the app has started ([#597](https://github.com/launchfile/launchfile/issues/597)). The processes keep running in the background with their pids recorded, and `launchfile down` stops them from any shell. Without `--detach` the native provider stays in the foreground as before. `DockerUpOpts.detach` is removed: the Docker provider never read it, because it always runs `docker compose up -d`. `launchfile --help` now lists `--detach`, `--quiet`, `--no-color` and `--schema-path`, and a test fails when a declared flag is missing from it.

- [#609](https://github.com/launchfile/launchfile/pull/609) [`d4924b2`](https://github.com/launchfile/launchfile/commit/d4924b2c777a830b91697fe5f20e064c5e28cd68) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - **Breaking:** `@launchfile/docker`, `@launchfile/macos-dev` and `launchfile` now declare an `exports` map that exposes only the package root. Deep imports such as `@launchfile/macos-dev/dist/provider.js` no longer resolve and fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Import from the package root instead: `import { ... } from "@launchfile/macos-dev"`. If you need something that the root does not export, open an issue asking for it to be made public. The map offers only the `import` condition, so load these packages with `import`, not CommonJS `require()`.

### Patch Changes

- [#649](https://github.com/launchfile/launchfile/pull/649) [`db542bc`](https://github.com/launchfile/launchfile/commit/db542bc2d10706e1b94f1e6c3349c256c156cb8b) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - `launch down` and `launch status` now refuse `--component` (bare and `=` forms) as well as `--components`, and exit 1 before the provider runs ([#414](https://github.com/launchfile/launchfile/issues/414)). Previously `launch down --component api` exited 0 and stopped every component. When both spellings appear, the message names `--components`.

- [#749](https://github.com/launchfile/launchfile/pull/749) [`3a331c8`](https://github.com/launchfile/launchfile/commit/3a331c890b858c66af2e926e625d306afaec6a43) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - Every write this provider makes under `.launchfile/`, and the `.env.local` it writes at the project root, is now confined to the real project directory ([#655](https://github.com/launchfile/launchfile/issues/655)). `.launchfile/` ships with the cloned repository, so a committed symlink at `.launchfile`, `.launchfile/env`, `.launchfile/logs`, `.launchfile/state.json`, `.env.local` or a storage volume directory would have sent state (database passwords), env files (secrets) and component logs to wherever it pointed. Each path component is checked without following links before anything is created, files are opened with `O_NOFOLLOW`, and `up` refuses with the path and the reason (`.launchfile/env is a symlink to /x; refusing to write`) and exits 1 before writing through the link. A project directory that itself sits under a symlink, such as `/tmp`, is still allowed. The same helper sets every directory to `0o700` and every secret-bearing file to `0o600` on each write, not only on creation, which covers the macos-dev rows of [#408](https://github.com/launchfile/launchfile/issues/408) and [#683](https://github.com/launchfile/launchfile/issues/683) (CWE-276). The sqlite provisioner's refusal from [#388](https://github.com/launchfile/launchfile/issues/388) now goes through the shared helper.

- [#602](https://github.com/launchfile/launchfile/pull/602) [`ca68e94`](https://github.com/launchfile/launchfile/commit/ca68e94c7f31e2339cff3e8fa3d2bb27a1a3215c) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - `launch down --destroy` now warns when it leaves a postgres or mysql database or user in place because its name in `.launchfile/state.json` is not a safe identifier. The warning never prints the rejected value or the stored password. The exit code is unchanged.

- [#731](https://github.com/launchfile/launchfile/pull/731) [`891688d`](https://github.com/launchfile/launchfile/commit/891688d91926851403994b0c35c4237709bb2662) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - A health block that declares both `path` and `command` now probes the `path`, as SPEC.md § health says. macos-dev used to run the `command` and, with no port allocated, report a `localhost:0` probe ([#730](https://github.com/launchfile/launchfile/issues/730)). A declared empty `path` also counts as a path check. The SDK writer keeps a declared empty `path` when it serializes a health block. The docker provider got the same fix in [#724](https://github.com/launchfile/launchfile/issues/724).

- [#653](https://github.com/launchfile/launchfile/pull/653) [`11efd8d`](https://github.com/launchfile/launchfile/commit/11efd8dd1fb8bfd429c8a829642bc1e6c45cc913) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - `httpsOriginSatisfied` and `REFUSED_PRIMARY_ADDRESS` now come from `@launchfile/sdk` ([#587](https://github.com/launchfile/launchfile/issues/587)). This provider's `src/https-origin.ts` re-exports both unchanged, so its internal imports keep working. Neither name is exported from the `@launchfile/macos-dev` package entry, before or after this change: import them from `@launchfile/sdk`. No behaviour change: the predicate and the address are the same values this provider defined itself.

- [#747](https://github.com/launchfile/launchfile/pull/747) [`c075a6a`](https://github.com/launchfile/launchfile/commit/c075a6a7000e091e1415765455dfd4ba54cf3454) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - `.env.local`, the per-component `.launchfile/env/*.env` files and `state.json` are now written through `writePrivateFile`, which tightens the open handle to `0o600` before writing ([#683](https://github.com/launchfile/launchfile/issues/683), CWE-276). `writeFile`'s `mode` option applies only when it creates the file, so a `.env.local` left at `0o644` by an earlier version stayed world-readable in the project root on every `up`. `.launchfile/env` is also chmodded to `0o700` after each `mkdir`, so `writeAllEnvFiles` no longer depends on `ensureDirs` having run first.

- [#656](https://github.com/launchfile/launchfile/pull/656) [`3f2e935`](https://github.com/launchfile/launchfile/commit/3f2e935dbef59f25c63ac84011465b320634c18d) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - The sqlite provisioner now refuses a symlinked data path ([#388](https://github.com/launchfile/launchfile/issues/388)). Before creating `.launchfile/data/sqlite` it checks, without following links, that `.launchfile`, `.launchfile/data` and `.launchfile/data/sqlite` are absent or real directories, and after the mkdir it confirms the directory resolves to itself under the real project root — the anchor `destroy()` already uses ([#370](https://github.com/launchfile/launchfile/issues/370)). A refused resource is skipped so the others still provision; `up` then exits 1 and names each refused required resource once, however many components share it. A refused optional resource is skipped and the run continues (D-8).

- [#662](https://github.com/launchfile/launchfile/pull/662) [`d0ded2c`](https://github.com/launchfile/launchfile/commit/d0ded2c10b2cadb4d9e188195f40ac39682272de) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - `.launchfile/`, each provisioned storage volume directory, and `.launchfile/data/sqlite` are set to `0o700` on every launch, not only when they are first created. `mkdir`'s `mode` applies at creation only, so a directory left by an earlier version or a looser umask stayed world-readable (CWE-276, [#408](https://github.com/launchfile/launchfile/issues/408)). `ensureDirs` already did this for its five subdirectories ([#382](https://github.com/launchfile/launchfile/issues/382)).

- [#711](https://github.com/launchfile/launchfile/pull/711) [`81c6079`](https://github.com/launchfile/launchfile/commit/81c60796a6c29a85a9e4a4c989fe5cf09b3af8c4) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - `launch up` now refuses `--component` (bare and `=` forms) and exits 1 before anything starts ([#658](https://github.com/launchfile/launchfile/issues/658)). Previously `launch up --component web` exited 0 and started every component. `--components` is unaffected. Scripts that relied on exit 0 for the singular spelling now fail, the same break D-67 accepted for the unified `launchfile` CLI.

- [#712](https://github.com/launchfile/launchfile/pull/712) [`9b60298`](https://github.com/launchfile/launchfile/commit/9b602981c8dcc9a6af516e6c89023cbdfc4194d3) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - `redactSecrets` masks the values in a URL fragment ([#628](https://github.com/launchfile/launchfile/issues/628), D-18, D-71), with the same rule as a query string: `https://host/cb#access_token=abc&state=xyz` prints as `#access_token=[REDACTED]&state=[REDACTED]`. A fragment with no `=` — a D-43 baseline ref such as `#develop` or `#<sha>` — is unchanged, and so is a `#` outside a URL (a shell comment, a CSS colour). The scan stays linear.

- [#632](https://github.com/launchfile/launchfile/pull/632) [`bc1c4f1`](https://github.com/launchfile/launchfile/commit/bc1c4f1faec25ff61c3d96cd7c0d626cd1c8d3fa) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - `redactSecrets` masks two more ways a URL carries a credential ([#575](https://github.com/launchfile/launchfile/issues/575), D-18). A userinfo with no password — `https://<token>@host` — is masked whole, and every value in a URL's query string is masked with its name kept, so `?token=abc&v=2` prints as `?token=[REDACTED]&v=[REDACTED]`. Parameters without `=` and scp-style `git@host:a/b` remotes are unchanged. Both patterns keep the bounded, linear-time scan. The docker provider's foreign-source refusal and dry-run warning mask the recorded and current source URLs; the raw URL the D-55 comparison and the state file use is not changed.

- [#701](https://github.com/launchfile/launchfile/pull/701) [`dca274b`](https://github.com/launchfile/launchfile/commit/dca274b2de2d359aad3d785f82296783c59a1dd1) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - Report a `requires[].version` range a provider cannot show is met, in every reference provider ([#404](https://github.com/launchfile/launchfile/issues/404), D-74). `@launchfile/sdk` exports `checkVersionRange(declared, provided)`, the one range comparison all three providers use: it classifies a declared node-semver range against the version or version family a provider runs as `satisfied`, `unsatisfied`, `undecidable`, `unknown` or `invalid`. `semver` moves from `@launchfile/docker` to `@launchfile/sdk`.
  
  `@launchfile/docker` now calls the shared comparison. Its warnings are unchanged.
  
  `@launchfile/macos-dev` read no `requires[].version` at all. Each resource provisioner now returns `warnings`, and `up` prints them. Postgres, MySQL/MariaDB and Redis ask the running server for its version and compare the range with it; a satisfied range is silent. A `mariadb` range is compared only against a MariaDB server. A `sqlite` range always warns, because the provider creates the file and supplies no SQLite library.
  
  `@launchfile/aws` built `engine_version` by deleting every non-digit from the range, and fell back to `"16"` when nothing was left: `>=9.6` became an exact `9.6`, `^7.0` became `7.0`, `20.x` became `20.`. It now passes a bare dotted version of one to three parts (`16`, `16.4`, `8.0.35`) through unchanged as `engine_version`, emits no `engine_version` for any other range, and records a `requires:<name>.version` workaround gap. This covers postgres, mysql and mariadb. ElastiCache redis ranges are compared with the Redis 7 family its `default.redis7` parameter group fixes. `catalog/apps/hedgedoc` (`>=9.6`) no longer gets a pin to the retired RDS PostgreSQL 9.6. Instead it records the gap in `CONFORMANCE.md`.

- [#633](https://github.com/launchfile/launchfile/pull/633) [`4143948`](https://github.com/launchfile/launchfile/commit/414394866633a2c6f7f829d9ea4c8e460732fe5c) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - Move the three D-65 conformance rules every provider must agree on — `allocateDbIndexes` (which numbered redis database each `db` use key gets), `namedDatabase` (what a named `database` use's database is called) and `withDatabasePath` (the URL that selects it) — plus the `DbIndexes` type into `@launchfile/sdk`, exported beside the use-key helpers. `@launchfile/docker` and `@launchfile/macos-dev` drop their identical copies and call the SDK's. No emitted value changes: compose files, env files and state records come out the same.
- Updated dependencies [[`2aa8017`](https://github.com/launchfile/launchfile/commit/2aa8017966832aa0f1e4ecd603349fa67089ea1f), [`6c27a10`](https://github.com/launchfile/launchfile/commit/6c27a108527fc46156805493c4986ec3fa04d631), [`e13e0c6`](https://github.com/launchfile/launchfile/commit/e13e0c621a03ac177e790d745eb6643e6310bfb0), [`891688d`](https://github.com/launchfile/launchfile/commit/891688d91926851403994b0c35c4237709bb2662), [`dca274b`](https://github.com/launchfile/launchfile/commit/dca274b2de2d359aad3d785f82296783c59a1dd1), [`420eca8`](https://github.com/launchfile/launchfile/commit/420eca84b4294623fcf33f477b8ace9ee2733dd5), [`10e7262`](https://github.com/launchfile/launchfile/commit/10e7262cf254816e233e5fde1f1f0bab9c47b2c4), [`11efd8d`](https://github.com/launchfile/launchfile/commit/11efd8dd1fb8bfd429c8a829642bc1e6c45cc913), [`4143948`](https://github.com/launchfile/launchfile/commit/414394866633a2c6f7f829d9ea4c8e460732fe5c)]:
  - @launchfile/sdk@0.15.0

## 0.14.0

### Patch Changes

- [#686](https://github.com/launchfile/launchfile/pull/686) [`fd76e78`](https://github.com/launchfile/launchfile/commit/fd76e787eacfa8d4b18ec749e80f5b3cc08200d9) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - `up --dry-run` now prints "would be reachable at" instead of "is running at" in its component summary ([#642](https://github.com/launchfile/launchfile/issues/642)). Nothing has started in a dry run, so the old wording claimed a state that did not exist. A real `up` is unchanged.
- Updated dependencies [[`6ec891b`](https://github.com/launchfile/launchfile/commit/6ec891bdfea097e436eb4c68f7dfe0d491830c22), [`3632d48`](https://github.com/launchfile/launchfile/commit/3632d48ba09532cdf11908dbb23103c5a2a07a57), [`91ca1a8`](https://github.com/launchfile/launchfile/commit/91ca1a84acfcfca20bcd4ba0c73e6fd5492b7692), [`dff6745`](https://github.com/launchfile/launchfile/commit/dff67458457392e6d9b6ab15a2651ebbc2dbb412), [`2c7d895`](https://github.com/launchfile/launchfile/commit/2c7d895ea3033f77857b8458c0d095a111787f5e)]:
  - @launchfile/sdk@0.14.0

## 0.13.0

### Minor Changes

- [#380](https://github.com/launchfile/launchfile/pull/380) [`4187622`](https://github.com/launchfile/launchfile/commit/4187622b3b9ca0e0f6203016af9777c2b7d13c20) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Run the source-mode prepare command (`install ?? build`) on demand instead of on every `up`, as D-38 requires. The only gate was `--no-build`, an opt-out a person had to remember, so every `up` reinstalled dependencies. `up` now fingerprints the prepare inputs — the command string plus the dependency manifests and lockfiles in the directory the command runs in — and records the fingerprint of each component's last successful run under `prepared` in `.launchfile/state.json`. A component whose fingerprint is unchanged is skipped and reports `Prepare up to date`; a first launch, an edited lockfile or manifest, or a changed `install`/`build` command re-runs it. Components sharing a working directory and command share one prepare, so it runs once per `up`. A failed prepare records nothing and is retried on the next `up`, and `--no-build` still skips the slot entirely. Dependency files nested below the working directory (a monorepo's per-workspace manifests) do not move the fingerprint. State files written by earlier versions carry no record, so the first `up` after upgrading prepares every component once.

- [#352](https://github.com/launchfile/launchfile/pull/352) [`295b883`](https://github.com/launchfile/launchfile/commit/295b8837043c756db662d7cce7dde137d9a33027) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Wire the D-41 component selector through to the providers as `--components <name>[,<name>…]` on `launchfile up` / `launchfile dev` and on the macOS provider's own `launch up`. Both providers already resolved a selector into the D-41 start-set through the SDK's `selectionClosure`; no entry point ever passed one, so every `up` started the whole app. The names are forwarded verbatim, so an unknown one still gets the provider's existing `Cannot select:` refusal. The flag is comma-separated and repeatable; omitting it starts every component, exactly as before.
  
  `--component` (singular) stays `bootstrap`'s single-component limiter. The CLI's flag table is global, so a verb that does not read a selector would still consume its value and drop it. The verbs a selector can apply to now refuse the spelling they do not implement: `up`/`dev` refuse `--component`, `bootstrap` refuses `--components`, and `down`/`status` refuse both rather than acting on every component while the operator named one. The remaining verbs (`logs`, `diagnose`, `list`, `validate`, `inspect`, `schema`) still parse either spelling and ignore it.

### Patch Changes

- [#591](https://github.com/launchfile/launchfile/pull/591) [`c4a8761`](https://github.com/launchfile/launchfile/commit/c4a87617d0b80764afbe6815df1e5552263f24c3) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - Redact `BootstrapResult.command` before returning it. Both providers echoed the bootstrap command through `redactSecrets` and then returned the same string unscrubbed on a public export, so a resolved `$secrets.*` value or resource password reached any consumer that printed or serialized a bootstrap result. The field now carries the redacted form on both the executed and the unrunnable path; the command the shell actually runs is unchanged, and `captures` is untouched.

- [#563](https://github.com/launchfile/launchfile/pull/563) [`c27dfb9`](https://github.com/launchfile/launchfile/commit/c27dfb9f2be782e1116323816562ce71a86cd251) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - Grade the declared uses of an `https-origin` entry before wiring it, instead of aborting the launch ([#536](https://github.com/launchfile/launchfile/issues/536), D-64, D-65 rules 3 and 4).
  
  A `requires:` entry declaring a use this provider cannot cover refuses its component before anything is provisioned or started; sibling components still launch. A `supports:` entry with the same shortfall runs degraded: its `set_env` bindings are absent and a warning names each uncovered use token. Launchfiles whose `https-origin` entries declare no `uses:` behave as before.

- [#527](https://github.com/launchfile/launchfile/pull/527) [`a47c3d3`](https://github.com/launchfile/launchfile/commit/a47c3d38135fdc8811cebb07f3c54f4e0a61a93d) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Fix `launchfile up --macos-dev` exiting 0 against an app that never came up. The provider polled a component's `health:` only to order the start of something that declared `depends_on: {condition: healthy}` on it, and then threw the result away — so a component nothing depended on was never checked at all, and a dependency that timed out still let its dependent start. SPEC.md § Failure semantics says a component that never becomes healthy fails the invocation, and the docker provider already does that.
  
  After every component has started, the provider now polls each declared `health:` check and fails `up` naming every component that did not pass within its budget, the probe it was asked (`GET http://localhost:<port><path>` or the `command`), and the budget it got. A check that declares `retries` gets the window the file states — `retries × (interval + timeout)`, the same window the docker provider's compose healthcheck gives it — and a check that declares none gets 60s; `start_period` is waited in full before either window opens. A `condition: healthy` gate fails the same way — the dependent is not started — and it fails closed when the dependency declares no `health:` or a `path` check has no port to poll, instead of treating an uncheckable dependency as satisfied. Processes that did start are left running and their pids are recorded in state, so `status` and `down` still reach them.
  
  For a process to outlive the failed `up`, its output can no longer flow through a pipe the `up` session holds: a server that logs each request would take EPIPE on its first request after the session exited. Each component now writes its stdout and stderr to `.launchfile/logs/<component>.log` itself, and the foreground session prints a tail of that file with the usual `[name]` prefix. The file is created readable by its owner only (0600), and a log an earlier run left with looser permissions is tightened to 0600, because a component's raw output can hold a secret it prints on first boot. The file therefore holds the process's raw lines — no per-line timestamp and no `ERR` marker, and stdout and stderr interleave as they would on a terminal. An app whose checks pass, and an app declaring no `health:`, behave as before apart from that log format.

- [#524](https://github.com/launchfile/launchfile/pull/524) [`45fba1a`](https://github.com/launchfile/launchfile/commit/45fba1ab9bb618f8336d7cf11107adef735c8ad6) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `up` and `status` print the supplied publication URL for the primary component ([#386](https://github.com/launchfile/launchfile/issues/386), D-58).
  
  With an `appUrl` set — on this run or recorded by an earlier one — the "is running at" summary and the `status` "Components:" list show that URL, as stored, on the primary component: the one `$app.*` reads (a declared `https-origin` component, else the first with an `exposed: true` endpoint), when a declared `https-origin` names its endpoint — `ws` and `grpc` included, since that entry's `url` is their `https` origin (D-60 rule 4) — or, with no such entry, when its first exposed endpoint is `http` or `https`. An undeclared `ws`, `tcp`, `udp` or `grpc` primary keeps this provider's own address, since the URL says nothing about what that listener speaks (D-58 rule 2). Every other component keeps this provider's own `http://localhost:<port>` (D-58 rule 4). A declared primary that `up` refuses places the URL on no component — never on a surviving sibling (D-72). With no URL supplied, output is unchanged.
  
  `LaunchState` gains `primaryEndpoint`, recorded at `up` so `status` places the URL on the same component without reading the Launchfile. `componentAddress`, `summaryLines` and `statusLines` are exported as the one address definition both printouts share; `primaryComponent` and `printedPrimaryEndpoint` are exported from the env writer. State files without the field load as before.

- [#345](https://github.com/launchfile/launchfile/pull/345) [`95df039`](https://github.com/launchfile/launchfile/commit/95df0392bdf474842cca95e6d9715c13a21e7c64) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Bound the repetitions in the ANSI-stripping and credential-URL patterns, so a long log line can no longer stall the provider that is reading it (CWE-1333).
  
  Two shapes were quadratic. `stripAnsi` in both providers' `bootstrap.ts` carried `\x1b\][^\x07]*\x07`: every `ESC ]` in captured stdout rescanned the whole remainder for a BEL a hostile log never supplies — 40 000 `ESC ]` pairs took 366 ms through `extractCaptures`. `CREDENTIAL_URL` in `@launchfile/macos-dev`'s redactor left the scheme repetition unbounded, so a long run of scheme-legal characters that never reaches `://` rescanned from every offset — 80 000 characters took 895 ms through `redactSecrets`. Both measured under Bun 1.4.0 on an Apple-silicon Mac; bounded, each takes under 1 ms. `@launchfile/docker`'s redactor was already bounded.
  
  The ANSI pattern now also ends an OSC string at ST (`ESC \`) as ECMA-48 requires, not only at BEL. The unbounded class ran past an ST into the next OSC, so an OSC 8 hyperlink lost its link text — and a `commands.*.capture` pattern looking for the URL in that text captured a string with escape bytes still in it. It now captures the URL.
  
  The CSI parameter bound is 64 rather than 32. One SGR that sets a truecolor foreground and background together — `ESC [ 38;2;255;255;255;48;2;240;240;240 m` — carries 33 parameter bytes, and a sequence past the bound is not stripped at all. `@launchfile/sdk` carries the same pattern and takes the same bound, so all three copies stay identical.
  
  The scheme bound excludes no URL: the pattern is unanchored, so against a scheme longer than the bound the match simply starts further into it and the password still redacts.

- [#559](https://github.com/launchfile/launchfile/pull/559) [`2e8a8ab`](https://github.com/launchfile/launchfile/commit/2e8a8ab8018fb21c10cd882ab4f59688d0bd9626) Thanks [@launchfile-steward](https://github.com/apps/launchfile-steward)! - Keep a refused `https-origin` component as the app's primary and resolve `$app.*` to the empty address ([#494](https://github.com/launchfile/launchfile/issues/494), D-72).
  
  `up` reads the declared primary before its refusals remove the component from the run, so a surviving sibling's port no longer becomes `$app.url`. The primary has no address: `$app.url`, `host`, `port`, `authority` and `scheme` resolve `""` and `tls` resolves `false`, in the env every surviving component receives; `env` and `bootstrap` compute the same. `$app.name` is unchanged, and so is every Launchfile whose declaring component launches.
- Updated dependencies [[`95df039`](https://github.com/launchfile/launchfile/commit/95df0392bdf474842cca95e6d9715c13a21e7c64)]:
  - @launchfile/sdk@0.13.0

## 0.12.0

### Minor Changes

- [#549](https://github.com/launchfile/launchfile/pull/549) [`036fac1`](https://github.com/launchfile/launchfile/commit/036fac13ecd17b56982710ce15d74ad6c6569bbe) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Launch a component whose `provides` entry declares `at:`, and report the names it answers at ([#547](https://github.com/launchfile/launchfile/issues/547), D-68 rule 5).
  
  A provider sets up the names a published entry declares or reports each one it did not set up; a silent launch is non-conformant. This provider starts each process on a local port with nothing in front that routes by host name, so every request reaches the listener with its `Host` intact and only name resolution is left to the operator. After the run summary, `up` prints one warning per declaring entry: the entry, the names under `localhost`, the local port requests arrive at, and the operator's options — map the name with a hosts file or DNS, or use a provider that routes host names. A dry run prints the same report without the port. Under a publication URL the report names the hosts under the supplied host and says that whatever routes that URL must send each name here.
  
  New export: `atReports(launch, ports?, suppliedAppUrl?)`. Nothing changes for a Launchfile that declares no `at:`.

### Patch Changes

- Updated dependencies [[`036fac1`](https://github.com/launchfile/launchfile/commit/036fac13ecd17b56982710ce15d74ad6c6569bbe)]:
  - @launchfile/sdk@0.12.0

## 0.11.0

### Minor Changes

- [#400](https://github.com/launchfile/launchfile/pull/400) [`abf6852`](https://github.com/launchfile/launchfile/commit/abf68525f653f9fd4f369e35661de5d452b857aa) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Make the documented `$components.<component>.<endpoint>.<property>` form resolve, and stop an unknown endpoint name resolving to the wrong port.
  
  SPEC.md has listed the four-segment named-endpoint form since D-6 gave `provides` entries a `name`, but no provider registered anything under those names — every provider built one flat `{url, host, port}` record per component from `provides[0]`. The reference did not merely fail: `resolveComponentPath` missed the `<endpoint>.<property>` key and fell back to the last path segment alone, so `$components.web.https.port` answered with the *first* endpoint's port. A sibling wired itself to a live, plausible, wrong port with nothing reported.
  
  - `@launchfile/sdk`: the `components.*` lookup no longer falls back to the last path segment — an endpoint name nobody registered resolves to the empty string (L-4), or to a `${...:-default}`. New `endpointProperties(provides, host)` export builds the flat `<endpoint>.host` / `.port` / `.protocol` (and `.url` when the protocol names a URL scheme) keys a provider registers — from the effective listener when it is handed the active certificate set (D-61); three-segment references such as `$components.backend.url` are unchanged.
  - `@launchfile/docker`, `@launchfile/aws`: register those keys for every declared endpoint at the sibling's in-network address, independent of D-27 publication — `exposed` governs the host boundary, not visibility between siblings. On docker, `<endpoint>.protocol` and `<endpoint>.url` read the effective listener (D-61): an endpoint whose certificate binding is active says `https`, as `$components.<name>.url` already does.
  - `@launchfile/macos-dev`: `buildResolverContext` takes the declared components as an optional seventh argument (after the `$app.endpoints` map and the declared uses) and registers the same keys. This provider allocates one host port per component; when the allocator has moved a component off every port it declares, no declared endpoint can be named at that port, so the component registers its primary keys only.

### Patch Changes

- [#502](https://github.com/launchfile/launchfile/pull/502) [`fd18324`](https://github.com/launchfile/launchfile/commit/fd18324ce7549dc8eed20dfdea71cef0456b68a6) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Fixed `launch down` signalling a process whose live start time is *earlier* than the recorded spawn — the identity check now compares the absolute difference, so a recycled pid, a backward clock jump, or a state file from another run all read as a mismatch and the process group is left untouched.
- Updated dependencies [[`abf6852`](https://github.com/launchfile/launchfile/commit/abf68525f653f9fd4f369e35661de5d452b857aa)]:
  - @launchfile/sdk@0.11.0

## 0.10.0

### Minor Changes

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

- [#401](https://github.com/launchfile/launchfile/pull/401) [`4d1e4c0`](https://github.com/launchfile/launchfile/commit/4d1e4c0cde984ae29beb1b630508218ba4b2ef70) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Anchor the allocated host port on the component's first `exposed: true` endpoint, falling back to `provides[0]`.
  
  `allocatePorts` read `component.provides?.[0]?.port` with no check on `exposed`, while `computeAppProperties` picked the component to publish by `p.exposed === true`. Two rules, one number. For `provides: [{port: 9000}, {port: 8080, exposed: true}]` the docker provider reported `8080` and macos-dev reported `9000` for the same file — the P-5 divergence, and it moved `$app.*`, `$components.<name>.*`, and the `PORT` the spawned process binds together, since this provider keeps one port per component.
  
  No shipped catalog app moves: the four apps with more than one `provides` entry mark every entry `exposed: true`. The parameter type widens to `Array<{ port: number; exposed?: boolean }>`.

- [#511](https://github.com/launchfile/launchfile/pull/511) [`a264017`](https://github.com/launchfile/launchfile/commit/a26401714640f779b4131f4e3b8555b25d728459) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Refuse a component whose `requires` entry names a resource type this provider has no provisioner for, instead of warning and starting it without the resource ([#461](https://github.com/launchfile/launchfile/issues/461), PROVIDERS.md §10 item 5). `launch up` previously printed `! No provisioner for resource type: <type> (skipping)` and went on to install, wire and start the component. The component is now removed from the run before anything is provisioned, installed, wired or started — the same shape as this provider's `https-origin` refusal — with a message naming the component and the entry. Sibling components still run. This provider has no supplied-resource channel, so a type it does not provision (`kafka`, `clickhouse`, `mongodb`, among others) can only be refused. `supports:` entries and host-capability entries are unchanged. A single-component app has no siblings, so this refuses it whole: `catalog/apps/posthog` (one component, requiring `clickhouse` and `kafka`) no longer starts on this provider at all, and nor do the `plausible`, `rocketchat`, `checkmate` and `librechat` drafts.

- [#519](https://github.com/launchfile/launchfile/pull/519) [`d2039b2`](https://github.com/launchfile/launchfile/commit/d2039b22ce1ed3fb5fc2fb7f2cb427d3582e4269) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Cover named repeatable uses ([#516](https://github.com/launchfile/launchfile/issues/516), SPEC.md § Resource uses). Each named redis `db` (`- db: cache`) gets its own numbered database on the Homebrew Redis, allocated by the same app-wide rule as `@launchfile/docker` — resources in the order their first `db`-declaring entry appears, the bare `db` first within a resource, named `db` uses after it in name order — and recorded in state per name so `env` and `bootstrap` answer with the databases `up` handed the app. Each named `database` on postgres, mysql or mariadb is one more database on the local server, `launchfile_<app>_<name>`, created through the same createdb / `CREATE DATABASE` + `GRANT` path as the app's own and dropped on `down --destroy`. A name on a use that does not repeat refuses the component naming the entry, the token and the name.

- [#515](https://github.com/launchfile/launchfile/pull/515) [`1796de9`](https://github.com/launchfile/launchfile/commit/1796de9ae8d42f920cca6a4326de9e2ed981fe2f) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Cover a `requires`/`supports` entry's declared `uses` or refuse the component ([#509](https://github.com/launchfile/launchfile/issues/509), SPEC.md § Resource uses, D-56 rule 1). For redis `db` the provider allocates one numbered database per entry on the Homebrew Redis it starts (index 0 first, within the app) and registers `db.url` (`redis://localhost:6379/<index>`) and `db.index`; `pubsub` and `server` are covered by that server; for postgres, mysql and mariadb `database` registers `database.url` and `database.name`, `server` the local instance. A `requires` entry declaring a use this provider cannot cover — a token it does not recognise included — is removed from the run before anything is provisioned, installed, wired or started, the same shape as its other refusals, with a message naming the component, the entry and the use. Under `--with-optional`, a `supports` entry with an uncovered use is left unfulfilled with a warning, never refused. A reference to a use the entry does not declare fails wiring with `UnresolvedUseError` instead of silently resolving the instance URL. Files that declare no `uses` are wired exactly as before.

### Patch Changes

- [#488](https://github.com/launchfile/launchfile/pull/488) [`ab3e359`](https://github.com/launchfile/launchfile/commit/ab3e359e70f00fe9758855b33cc99506e1736dc2) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `$app.endpoints.<name>.*` resolves `""` for every property on this provider, and `up` says so ([#463](https://github.com/launchfile/launchfile/issues/463), D-63 rule 4, [#294](https://github.com/launchfile/launchfile/issues/294)).
  
  The allocator hands out one port per component, not one per endpoint, so there is no per-endpoint address to publish — the primary's included; `$app.*` keeps its own routing answer. `computeAppEndpoints(launch)` registers the empty answer for every named published endpoint on the resolver context (`buildResolverContext` takes it as a fifth argument), and `up` warns once naming the endpoints the file references.

- [#382](https://github.com/launchfile/launchfile/pull/382) [`2f47bdf`](https://github.com/launchfile/launchfile/commit/2f47bdf87d86a8744900ce00387af62c633c770a) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Fix `.launchfile/` state directories (`env`, `storage`, `tmp`, `logs`, `data`) staying world-readable when the directory already existed (CWE-276). `ensureDirs` passed `mode: 0o700` to `mkdir`, but `mkdir`'s mode only applies when it creates the directory — a directory left at a looser mode by an earlier Launchfile version, a permissive umask, or a manual `mkdir` stayed at that mode forever. `ensureDirs` now `chmod`s each directory unconditionally after `mkdir`, mirroring the retrofit already shipped in `packages/launchfile/src/state/errors.ts`. Also adds the mode to the two other `.launchfile/env` `mkdir` call sites for consistency (issue [#252](https://github.com/launchfile/launchfile/issues/252)).

- [#370](https://github.com/launchfile/launchfile/pull/370) [`6afe9b4`](https://github.com/launchfile/launchfile/commit/6afe9b41ccc6b9c20ac89cc18553637f14fe7565) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Confine `launchfile down --destroy` to the project directory when it removes a sqlite database file. `SqliteProvisioner.destroy()` deleted whatever absolute path `.launchfile/state.json` named, and that file lives inside the cloned repo and is parsed without validation — so a repository could ship a state file pointing `dbName` at any file on the machine and have it deleted. The path is now resolved through the filesystem and refused unless it really sits under `<projectDir>/.launchfile/data/sqlite/`, the directory `provision()` writes to. Both ends of the comparison go through `realpath`, anchored on the caller-supplied project directory, so a repo that ships the data directory as a symlink out of the project cannot smuggle a delete past a string-prefix check. A refused path prints a warning and teardown continues to the next resource, so a poisoned state file cannot wedge cleanup. Legitimate cleanup is unaffected.
- Updated dependencies [[`ab3e359`](https://github.com/launchfile/launchfile/commit/ab3e359e70f00fe9758855b33cc99506e1736dc2), [`f40e7b6`](https://github.com/launchfile/launchfile/commit/f40e7b68d99f61d777455f0f79e4ab94d2cf1519), [`3587317`](https://github.com/launchfile/launchfile/commit/35873173251a6a8e9f97d5fae592fa7fd998bf7d), [`31dbac2`](https://github.com/launchfile/launchfile/commit/31dbac2a4c58dc50c4d4959facf6ff0b3aefa1e3), [`1123da3`](https://github.com/launchfile/launchfile/commit/1123da37959a0fbebca27c112ed6e8ebd8dc0bff), [`d2039b2`](https://github.com/launchfile/launchfile/commit/d2039b22ce1ed3fb5fc2fb7f2cb427d3582e4269), [`1796de9`](https://github.com/launchfile/launchfile/commit/1796de9ae8d42f920cca6a4326de9e2ed981fe2f), [`39df9db`](https://github.com/launchfile/launchfile/commit/39df9db10c64b7fded71e9afd74c08c7a8614285), [`a399ba3`](https://github.com/launchfile/launchfile/commit/a399ba365a2c7a3fe3b349d43810d3ff329e77c2)]:
  - @launchfile/sdk@0.10.0

## 0.9.0

### Minor Changes

- [#484](https://github.com/launchfile/launchfile/pull/484) [`b5022ae`](https://github.com/launchfile/launchfile/commit/b5022aed608e2ccd65857fb9a045337faeb94830) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `launchBootstrap({ reveal })` prints sensitive captures on the operator's explicit request, and every sensitive capture registers with the redactor at extraction ([#464](https://github.com/launchfile/launchfile/issues/464)).
  
  A bootstrap capture declared `sensitive: true` prints masked with a hint naming `launchfile bootstrap --reveal`; `reveal: true` prints the value. Masking is display only: the value is registered with the redactor before any result or printed line is built — also under `reveal` — so a failing command's stderr and every later diagnostic are scrubbed of it.

### Patch Changes

- Updated dependencies [[`b5022ae`](https://github.com/launchfile/launchfile/commit/b5022aed608e2ccd65857fb9a045337faeb94830)]:
  - @launchfile/sdk@0.9.0

## 0.8.0

### Minor Changes

- [#468](https://github.com/launchfile/launchfile/pull/468) [`fc92434`](https://github.com/launchfile/launchfile/commit/fc9243433293ac0c2061d25f6c83b352985c023f) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Refuse a selected certificate binding instead of starting the component in cleartext (D-61 rule 5).
  
  This provider has no supplied-resource channel, so it can never receive a `cert_file`/`key_file` pair and can never activate native TLS. Selection here is `--with-optional`: without it a `tls:` binding is inactive and the declared HTTP baseline is the correct deployment (D-8); with it the operator asked for TLS this provider cannot give, and the component is removed from the run with a surfaced message naming the entry — the refusal PROVIDERS.md §10 item 5 makes conformant.

- [#465](https://github.com/launchfile/launchfile/pull/465) [`dc8a759`](https://github.com/launchfile/launchfile/commit/dc8a75968f56be9811d9feda38ceb640e453be9b) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - Refuse a component whose `requires:` declares an `https-origin` (D-60 rule 5).
  
  This provider has no edge and no orchestrator-facing publication channel ([#294](https://github.com/launchfile/launchfile/issues/294)), so it can neither provision a public HTTPS origin nor accept a supplied one. It refuses — which PROVIDERS.md §10 item 5 makes conformant — and the refusal is the removal: the component is dropped from the run before anything is installed, wired, registered or started, exactly as for an ungrantable host capability. A `supports:` entry is not refused; the component runs and the un-granted dependency is noted.
  
  New exports: `refusedHttpsOrigins(launch)` and `applyHttpsOriginRefusals(launch)`.

### Patch Changes

- Updated dependencies [[`fc92434`](https://github.com/launchfile/launchfile/commit/fc9243433293ac0c2061d25f6c83b352985c023f), [`dc8a759`](https://github.com/launchfile/launchfile/commit/dc8a75968f56be9811d9feda38ceb640e453be9b)]:
  - @launchfile/sdk@0.8.0

## 0.7.0

### Minor Changes

- [#315](https://github.com/launchfile/launchfile/pull/315) [`78e654d`](https://github.com/launchfile/launchfile/commit/78e654dee040d6eb2e1aa18bb850b219de777996) Thanks [@ziadsawalha](https://github.com/ziadsawalha)! - `@launchfile/macos-dev` implements the D-50 operator-supplied storage channel ([#296](https://github.com/launchfile/launchfile/issues/296)), the last of the three surfaces D-50's conformance paragraph named. `provisionStorage` previously `mkdir`ed every declared volume and never read `volume.content`, so a `storage.<name>.content: operator` volume was created empty and the app started against it — the silent success the marker exists to catch.
  
  **`launchfile up --native --storage <volume>=<path>` now works** where it previously exited with "not yet supported". All four D-50 states hold: a supplied path becomes the volume's path, a marked volume with no path fails the launch naming the flag that satisfies it, a supplied path that is absent or unreadable fails the launch and is never created, and an unmarked volume keeps its `.launchfile/storage/<component>/<name>` path byte-for-byte. Because this provider runs processes on the host, the grant is the path injected as `$storage.<name>.path` (D-39) rather than a mount. The refusal lands before state, directories, resources, ports, runtimes or processes exist, so `--dry-run` refuses too. `launchfile env` reports the bound path from provider state, not a `.launchfile/` path the app never read.
  
  **A Launchfile with a `content: operator` volume that ran under the native provider before now fails until its paths are supplied.** That is the point of the change: what those runs produced was an empty directory standing in for the operator's content.
  
  `@launchfile/sdk` gains `indexOperatorStoragePaths` — D-50 rule 1's key rule, previously implemented separately in the docker provider and the catalog harness — along with `UnboundOperatorStorageError`, `MissingOperatorStoragePathError`, `StorageBind` and `UnboundOperatorVolume`, moved from `@launchfile/docker` so one caller-side catch covers every provider that raises them.
  
  `@launchfile/docker` reads both from the SDK instead of defining them. Its public API, refusal messages, warning text and generated compose are unchanged.

### Patch Changes

- Updated dependencies [[`78e654d`](https://github.com/launchfile/launchfile/commit/78e654dee040d6eb2e1aa18bb850b219de777996)]:
  - @launchfile/sdk@0.7.0

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
