---
"@launchfile/sdk": patch
"@launchfile/docker": patch
---

A multi-segment resource reference now reads its whole tail as one key, with no last-segment fallback (#514). On `requires: postgres` registering `host`, `$postgres.host` is still `pg-host`, but a mistyped `$postgres.deep.host` resolves `""` (so a `:-default` applies) instead of quietly answering with `host`. A registered dotted key still resolves, and an entry that declares `uses` still throws `UnresolvedUseError` on a path its uses cannot answer. On a supplied resource, `@launchfile/docker` now names such a reference in its existing warning: `set_env references postgres.deep.host, which the supplied resource does not provide — resolved to ""`. No catalog Launchfile uses the form.
