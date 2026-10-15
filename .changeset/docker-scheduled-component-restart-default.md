---
"@launchfile/docker": patch
---

Default a component that declares `schedule:` and no `restart:` to `restart: "no"` instead of `unless-stopped`. Compose re-runs a service's command on every clean exit under `unless-stopped`, so a one-shot job body (`start: "node scripts/sync.js"`) executed its work again on each restart-backoff cycle while the project reported as healthy. An explicit `restart:` still wins, and a component without `schedule:` or `restart:` still gets `unless-stopped`, with byte-identical compose output. Any `restart` that resolves to `no` is now emitted quoted (`restart: "no"`), including an author's explicit value, so a YAML 1.1 loader reads it as the string, not boolean `false`. The D-51 launch-time warning now names the restart policy, but only when the provider chose it.

The `launchfile up` health gate now polls with `docker compose ps --all` and passes a service whose `restart` resolves to `no` or `on-failure` once it has exited 0, instead of waiting out the 120s budget for a job that already finished. Such a service does not pass on a non-zero exit: the gate keeps polling and names it when the budget runs out. A `restart: "no"` component that exits non-zero beside a running sibling therefore now fails `up`, where it used to drop out of the poll unseen. `ComposeResult` gains `mayExit`, the list of those services.
