---
"@launchfile/docker": patch
---

Default a component that declares `schedule:` and no `restart:` to `restart: "no"` instead of `unless-stopped`. Compose re-runs a service's command on every clean exit under `unless-stopped`, so a one-shot job body (`start: "node scripts/sync.js"`) executed its work again on each restart-backoff cycle while the project reported as healthy. An explicit `restart:` still wins, and a component without `schedule:` or `restart:` still gets `unless-stopped`, with byte-identical compose output. Any `restart` that resolves to `no` is now emitted quoted (`restart: "no"`), including an author's explicit value, so a YAML 1.1 loader reads it as the string, not boolean `false`. The D-51 launch-time warning now names the restart policy, but only when the provider chose it.
