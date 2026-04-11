---
"@launchfile/sdk": minor
---

Move capture from the top-level `outputs:` field into a nested `capture:` field on the expanded `commands.*` form, and introduce `commands.bootstrap` as a new lifecycle stage for user-invoked post-start setup. The capture mechanism from D-23 (`pattern` / `description` / `sensitive`) is preserved verbatim — only the placement changes, per D-34's P-10 (source of truth co-located) rationale.

**Breaking:** removes `outputs?: Record<string, Output>` from the `Launch` and `Component` types and the corresponding top-level schemas in `LaunchSchema` and `ComponentSchema`. Legitimate under 0.x semver: zero catalog or example Launchfiles declared `outputs:` at the time of removal, and there is no downstream production usage to preserve. Launchfiles that previously used `outputs:` should move the block under the command it captures from — e.g. `outputs.admin_password` with the `release` command becomes `commands.release.capture.admin_password`.

See [#16](https://github.com/launchfile/launchfile/issues/16) for the RFC trail and [DESIGN.md D-34](https://github.com/launchfile/launchfile/blob/main/spec/DESIGN.md#d-34-capture-block-co-located-with-commands-supersedes-d-23-placement) for the full migration rationale.
