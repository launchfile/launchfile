---
"@launchfile/docker": patch
---

The Docker provider now escapes every `$` it writes into the compose file from Launchfile text, so `docker compose` no longer fills a `$VAR` from the environment of the shell that runs it.

- `commands.start` and `health.command`: a `$VAR` or `${VAR:-default}` now reaches the container's shell as written. It no longer takes the host's value. An author's `$$VAR` still reaches the shell as `$VAR`, so files that already use `$$` behave as before.
- `env` and `set_env` values, and operator-supplied values for `required:` variables: a `$` left after resolution, such as the `$` from a `$$` escape or a `$` inside a password, now reaches the container as a literal `$`.
- The elasticsearch backing service's healthcheck now reads the container's `ELASTIC_PASSWORD`. Before, compose replaced it with the host's value, or with an empty string when the host had none, so the check sent the wrong password.

Orchestrators that escape `$` to `$$` in the compose file this provider writes, or in values they hand it for `start`, `health.command` or `env`, must stop doing so. Otherwise the escapes double up and the container receives `$$`.
