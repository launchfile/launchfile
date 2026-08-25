---
"@launchfile/docker": minor
---

`ComposeOpts.appUrl` / `DockerUpOpts.appUrl`: orchestrator-supplied publication context (#290). When routing is owned outside the compose project (reverse proxy, tunnel, edge), the orchestrator can now hand the provider the app's public URL, and `$app.*` — `url`, `host`, `port`, `authority`, `scheme`, `tls` — resolves from it instead of `http://localhost:<hostPort>`, identically across env generation, bootstrap, and release. The value is persisted in state so later verbs and re-runs agree; a different value on a subsequent `up` replaces it and recomputes the derived env, while omitting it preserves what is recorded. A malformed URL (non-http(s) scheme, userinfo, query, fragment, or unparseable) is refused with `InvalidAppUrlError` — never degraded, never a silent localhost fallback. Unset, output is byte-for-byte unchanged. The URL asserts the primary endpoint's public address only.
