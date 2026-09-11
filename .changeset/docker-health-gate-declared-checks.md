---
"@launchfile/docker": patch
---

Fix `launchfile up` reporting `✓ Health check passed` for a container in a crash loop. The health gate decided "this service declares no health check" from an empty `Health` string in `docker compose ps --format json`, but docker reports that same empty string for a service that *does* declare a check whose result is not yet known — which is what a restarting container reports, in windows of roughly 230ms. A 3s poll landing in one of those windows passed the gate, contradicting SPEC.md § Failure semantics ("a component that never becomes healthy fails the invocation").

The provider generates the compose file, so it already knows which services it gave a `healthcheck:` block. `ComposeResult` now carries that fact as `healthchecks` — every emitted compose service name (backing services included) mapped to whether it declares a check — and the gate reads it instead of guessing. A service that declares a check is healthy only when `Health` is `healthy`; a service that declares none is healthy once it is running; a container matching no generated service is never healthy. No grace window and no debounce: unknown means keep waiting, and the 120s budget is unchanged.

The gate names those services in the `docker compose ps` poll. `up -d` leaves the container of a renamed or removed service running as an orphan, and an unscoped poll still reports it under its old service name — a name the gate matches to nothing, so it would wait out the full 120s and then fail naming a component the app no longer has.

An app whose check genuinely passes, and an app declaring no `health:` at all, behave exactly as before.
