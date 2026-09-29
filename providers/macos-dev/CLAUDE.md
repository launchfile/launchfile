# macOS Dev Provider — Working Context

> For project-wide context, see [../../CLAUDE.md](../../CLAUDE.md)

## What's Here

A Launchfile provider that runs apps natively on macOS for local development. Uses Homebrew services for databases (postgres, redis, mysql, etc.) and native runtimes (node via fnm, python via pyenv, ruby via rbenv, bun via brew).

## Philosophy

- **Source-first** — ignores `image:`, uses `runtime:` + native package managers
- **Source-mode commands** — runs from source: `install ?? build` for prepare, `dev` over `start` for run (D-38); `release`/`bootstrap`/`seed`/`test` are mode-invariant. Commands run natively with user privileges, so this provider is for local, trusted sources
- **Prepare on demand** — the prepare command runs on first launch and whenever its inputs change (the command itself, or a dependency manifest/lockfile in its working directory), never on every `up` (D-38). `prepare-fingerprint.ts` computes the signal; `state.prepared` records it
- **Brew-first** — shared database services, app-specific databases namespaced by app name
- **Supports skip by default** — use `--with-optional` for optional resources

## Timeout defaults (PROVIDERS.md §10.10)

Budgets applied when a command declares no `timeout:`:

| Command                        | Default |
|--------------------------------|---------|
| prepare (`install` ?? `build`) | 10m     |
| `release`                      | 2m      |
| `bootstrap`                    | 2m      |
| health gate (per component)    | `retries × (interval + timeout)` when `retries:` is declared; otherwise 60s |
| exit watch (component with no `health:`) | 2s after spawn (`EXIT_WATCH_MS`) |

An unparseable declared `timeout` is surfaced, never silently replaced: prepare/`release` fail the launch, `bootstrap` reports the failure to the invoker.

A component that declares `health:` and never passes it within its budget fails `up` (SPEC.md § Failure semantics), whether or not anything depends on it. The budget is the file's own window when it declares `retries:` — `retries × (interval + timeout)`, with `interval` defaulting to 3s and `timeout` to 5s — and 60s otherwise; `start_period:` is waited in full first and is not part of it. Its process is left running and its pid recorded, so `status` and `down` still reach it. The process writes `.launchfile/logs/<component>.log` itself (raw stdout and stderr, no timestamps) and the foreground `up` prints a tail of that file; a pipe held by `up` would kill the process on its next write once `up` had exited.

A component whose process exits non-zero (or dies to a signal) before `up` returns has not come up, and fails `up` with the run slot's disposition (SPEC.md § Failure semantics), naming the component and its exit code. A component with `health:` is watched for as long as its check is polled, and the poll stops the moment the process exits rather than running out the budget. A component with no `health:` is watched for `EXIT_WATCH_MS` (2s) after spawn: an exit inside that window fails `up`; a process that outlives it counts as up, since without a check there is nothing else to ask. Exit 0 inside the window is not a failure for a component with no `health:`; a component with `health:` has come up only once its check passes, so any exit before that fails `up`, exit 0 included. Components that did start are left running and named on stderr, with their pids recorded, so `status` and `down` reach them; the CLI records the deployment with status `unknown`.

## Commands

```bash
bun install        # Install dependencies
bun test           # Run all tests (vitest)
bun run typecheck  # Type-check without emitting
```

This package is a library consumed by the unified `launchfile` CLI (`packages/launchfile`). End users run `npx launchfile up`, not this package directly.

## Architecture

- `provider.ts` — Main orchestration (`launch up` sequence)
- `env-writer.ts` — Resolves `$` expressions via SDK and writes `.env.local`
- `resources/` — Brew-based provisioners (postgres, redis, mysql, sqlite)
- `runtimes/` — Version manager integrations (fnm, pyenv, rbenv)
- `process-manager.ts` — Multi-component startup with topological sort and health waits
- `state.ts` — Persists secrets, ports, credentials, and prepare fingerprints in project-local `.launchfile/state.json`
- `prepare-fingerprint.ts` — Digests the prepare inputs so `install ?? build` runs on demand (D-38)

## Dependencies

- `@launchfile/sdk` — Parsing, validation, expression resolution
- `semver` — Version constraint matching for brew formulae
