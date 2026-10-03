---
"@launchfile/macos-dev": minor
"@launchfile/docker": patch
"launchfile": patch
---

`launchfile up --native --detach` and `launchfile dev --detach` now return once the app has started (#597). The processes keep running in the background with their pids recorded, and `launchfile down` stops them from any shell. Without `--detach` the native provider stays in the foreground as before. `DockerUpOpts.detach` is removed: the Docker provider never read it, because it always runs `docker compose up -d`. `launchfile --help` now lists `--detach`, `--quiet`, `--no-color` and `--schema-path`, and a test fails when a declared flag is missing from it.
