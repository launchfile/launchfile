---
"@launchfile/macos-dev": minor
---

Cover named repeatable uses ([#516](https://github.com/launchfile/launchfile/issues/516), SPEC.md § Resource uses). Each named redis `db` (`- db: cache`) gets its own numbered database on the Homebrew Redis, allocated by the same app-wide rule as `@launchfile/docker` — resources in the order their first `db`-declaring entry appears, the bare `db` first within a resource, named `db` uses after it in name order — and recorded in state per name so `env` and `bootstrap` answer with the databases `up` handed the app. Each named `database` on postgres, mysql or mariadb is one more database on the local server, `launchfile_<app>_<name>`, created through the same createdb / `CREATE DATABASE` + `GRANT` path as the app's own and dropped on `down --destroy`. A name on a use that does not repeat refuses the component naming the entry, the token and the name.
