---
"@launchfile/aws": patch
---

Report every declared field of a component that `translate` cannot build. A component with `image:` and no `runtime:`, or with neither `runtime:` nor `commands.start` (the path a `build.dockerfile`-only component takes), stopped at its `image` or `runtime` gap before any per-field row was recorded, so its `env`, `restart`, `health`, `storage`, `provides`, `depends_on`, `commands.*`, and `schedule` vanished from the conformance report. Each declared field now gets its own `workaround` row naming the field (PROVIDERS.md §10 rule 8, D-51). Fields the file does not declare still get no row, and rows already recorded above those returns (`requires:host.*`, `supports:host.*`, `host.docker`, unsupplied-required `env.<NAME>`) are not repeated.
