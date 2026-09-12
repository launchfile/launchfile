---
"@launchfile/docker": minor
---

Refuse a component whose `requires` entry names a type this provider has no factory for, instead of warning and starting it without the resource ([#461](https://github.com/launchfile/launchfile/issues/461), PROVIDERS.md §10 item 5). `launchfile up` on such a file previously printed `Unknown backing service type: <type> — skipped` and launched the component anyway — `catalog/apps/posthog` came up with `KAFKA_HOSTS` unset and reported success. The component is now refused before anything of it is emitted, with a message naming the component, the entry, the type, and both ways out: supply the resource through the provider's supplied-resource channel (D-56), or use a provider that provisions the type. Sibling components still launch. A resource supplied through `ComposeOpts.resources` is checked first and still wins; `supports:` entries are unchanged.

Added a `kafka` backing service (Redpanda `v25.1.12`, one container, no ZooKeeper) exposing `url`, `host` and `port`, so `requires: kafka` provisions a broker gated on its readiness endpoint. `sqlite` remains without a factory and is now refused rather than skipped.
