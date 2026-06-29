---
"@launchfile/sdk": minor
"@launchfile/docker": minor
"launchfile": minor
---

Resolve `$app.url` (and the rest of the `$app.*` set) on the public `npx launchfile up` path. An app that references its own public URL — e.g. `$app.url` in an `env` value — now resolves correctly when launched via the Docker provider, not only in local dev.
