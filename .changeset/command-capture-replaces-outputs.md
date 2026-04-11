---
"@launchfile/sdk": minor
"@launchfile/docker": minor
"@launchfile/macos-dev": minor
"launchfile": minor
---

Move capture from the top-level `outputs:` field into a nested `capture:` field on the expanded `commands.*` form, and introduce `commands.bootstrap` as a new lifecycle stage for user-invoked post-start setup. The capture mechanism from D-23 (`pattern` / `description` / `sensitive`) is preserved verbatim — only the placement changes, per D-34's P-10 (source of truth co-located) rationale.

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
