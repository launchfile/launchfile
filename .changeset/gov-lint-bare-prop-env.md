---
"@launchfile/sdk": minor
---

`lintLaunch` now warns on a bare `$prop` reference inside an `env:` value (#184). `env:` is evaluated with no resource in context, so `$host`/`${port:-5432}`-style references written there can never resolve against a resource the way the same syntax does in `set_env:` — they always fall through to their `:-default` fallback, or to an empty string when they have none, regardless of spelling. The check shares the `bareReferences()` helper already used by the D-46 known-property-vocabulary check, stays warn-only, and touches neither the resolver nor validation's `valid`/exit-code outcome. Command-string references (`commands.*.command`) fail the same way but are tracked separately in #227.
