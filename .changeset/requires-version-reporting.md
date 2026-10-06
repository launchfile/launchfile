---
"@launchfile/sdk": minor
"@launchfile/docker": patch
"@launchfile/macos-dev": patch
"@launchfile/aws": patch
---

Report a `requires[].version` range a provider cannot show is met, in every reference provider (#404, D-74). `@launchfile/sdk` exports `checkVersionRange(declared, provided)`, the one range comparison all three providers use: it classifies a declared node-semver range against the version or version family a provider runs as `satisfied`, `unsatisfied`, `undecidable`, `unknown` or `invalid`. `semver` moves from `@launchfile/docker` to `@launchfile/sdk`.

`@launchfile/docker` now calls the shared comparison. Its warnings are unchanged.

`@launchfile/macos-dev` read no `requires[].version` at all. Each resource provisioner now returns `warnings`, and `up` prints them. Postgres, MySQL/MariaDB and Redis ask the running server for its version and compare the range with it; a satisfied range is silent. A `mariadb` range is compared only against a MariaDB server. A `sqlite` range always warns, because the provider creates the file and supplies no SQLite library.

`@launchfile/aws` built `engine_version` by deleting every non-digit from the range, and fell back to `"16"` when nothing was left: `>=9.6` became an exact `9.6`, `^7.0` became `7.0`, `20.x` became `20.`. It now passes a bare `16` or `16.4` through unchanged, emits no `engine_version` for any other range, and records a `requires:<name>.version` workaround gap. This covers postgres, mysql and mariadb. ElastiCache redis ranges are compared with the Redis 7 family its `default.redis7` parameter group fixes. `catalog/apps/hedgedoc` (`>=9.6`) no longer gets a pin to the retired RDS PostgreSQL 9.6. Instead it records the gap in `CONFORMANCE.md`.
