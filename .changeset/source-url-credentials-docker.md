---
"@launchfile/docker": patch
---

`resolveSource` no longer echoes credentials from a Launchfile URL. When fetching `https://user:token@host/…` fails, the error names the URL with the password shown as `[REDACTED]`. This covers a non-OK response and a rejected fetch, including Node's own "URL includes credentials" error. The `url` returned on success is unchanged.
