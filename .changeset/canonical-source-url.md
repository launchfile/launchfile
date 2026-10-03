---
"@launchfile/sdk": minor
"@launchfile/docker": patch
"launchfile": patch
---

A URL source is no longer stored with its credentials. `@launchfile/sdk` adds `canonicalSourceUrl(url)`, which removes userinfo and credential query parameters (`CREDENTIAL_QUERY_KEYS`: `token`, `access_token`, `private_token`, `auth`, `key`, `password`, `secret`, `sig`, `signature` and others, matched case-insensitively) and keeps the scheme, host, port, path, other query parameters and the `#<ref>` fragment.

The docker provider records `sourceUrl` in this form and the D-55 foreign-source guard compares canonical forms, so the same source fetched with a rotated token is no longer refused. A state file holding a raw URL still matches and is rewritten on the next `up`. The CLI keys a URL deployment in `index.json` by the canonical form, and lookups match older rows that hold the raw URL.

Behavior change: `loadDockerSource` and `DockerUpResult.sourceUrl` now return the canonical form, never the credential-bearing URL. A caller that used the stored `sourceUrl` to fetch again must supply the credential itself.
