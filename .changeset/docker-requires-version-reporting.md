---
"@launchfile/docker": patch
---

Report a `requires[].version` constraint the provider cannot meet, instead of dropping it ([#271](https://github.com/launchfile/launchfile/issues/271)). Every backing-service factory pins one image tag — `postgres:16-alpine`, `mysql:8`, `mariadb:11`, `redis:7-alpine`, `mongo:7`, `clickhouse/clickhouse-server:latest` — and no code path read the declared range, so a Launchfile asking for `version: ">=17"` got postgres 16 with no diagnostic. PROVIDERS.md §10 rule 8 requires the gap to be surfaced.

This provider still never selects a version. It compares the declared range against the tag the deployment actually runs — after any `config.extensions` image substitution — and reacts three ways. A tag whose whole version family satisfies the range is honored and stays silent: `>=15` against `postgres:16-alpine` warns nothing, which is what keeps the three shipped catalog entries that declare `version` (hedgedoc, hedgedoc-v2, plausible) quiet. A range the tag can never satisfy warns that it is not satisfied. A range the tag is too coarse to decide (`^16.2` against `16`), a tag with no version (`latest`), and an unparseable range each warn that the constraint could not be checked.

Warnings name the entry by its `name ?? type`, the declared range, and the image this provider runs. They state what the provider does and never predict what the app will do. They go through the existing warning channel, so `up` prints them and the structured log carries them.

`semver` joins the dependencies for the range comparison, matching the version `@launchfile/macos-dev` already uses.
