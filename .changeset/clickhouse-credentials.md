---
"@launchfile/docker": patch
---

Start ClickHouse with a generated password ([#246](https://github.com/launchfile/launchfile/issues/246)).

The `clickhouse` factory now mints a password under the `clickhouse` key in `resourcePasswords`, the same way the other credentialed backing services do. It sets `CLICKHOUSE_USER=default` and `CLICKHOUSE_PASSWORD` on the server, and reports `password` and a `url` of the form `http://default:<url-encoded password>@<host>:8123`. The image writes these into `users.d` on every start, so an existing ClickHouse volume picks up the password when its container is recreated.

A Launchfile that connects to ClickHouse must now pass the credentials: bind `$user`/`$password`, or use `$url`, which carries them.
