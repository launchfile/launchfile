---
"@launchfile/sdk": minor
"@launchfile/docker": patch
"@launchfile/macos-dev": patch
---

Move the three D-65 conformance rules every provider must agree on — `allocateDbIndexes` (which numbered redis database each `db` use key gets), `namedDatabase` (what a named `database` use's database is called) and `withDatabasePath` (the URL that selects it) — plus the `DbIndexes` type into `@launchfile/sdk`, exported beside the use-key helpers. `@launchfile/docker` and `@launchfile/macos-dev` drop their identical copies and call the SDK's. No emitted value changes: compose files, env files and state records come out the same.
