---
"@launchfile/sdk": minor
"@launchfile/docker": minor
"@launchfile/macos-dev": minor
"launchfile": minor
---

Lifecycle failure semantics + duration grammar (D-47). `validate` now warns on any duration outside the ratified grammar `^(\d+)(ms|s|m|h)$` (`commands.*.timeout`, `health.interval`/`timeout`/`start_period`); the SDK exports `parseDurationMs`/`isValidDuration`/`lintDurations`. The docker provider now executes a declared `release` before `start` as a one-shot `docker compose run --rm` (resources ready first via `depends_on`) and fails the deploy on error. Both providers surface an unparseable duration instead of silently substituting a 120s default: release/prepare fail the deploy/launch, bootstrap reports the failure.
