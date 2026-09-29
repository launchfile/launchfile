---
"@launchfile/sdk": minor
---

`lintLaunch` now warns when one env var name is declared with `generator: secret` or `generator: uuid` in two or more components (#425). A `generator:` mints once per declaration (D-49), so each component gets a different value, which breaks apps whose components must share it (a Rails `SECRET_KEY_BASE`, a signing key). The warning names the variable, every declaring component, and the fix: declare the value once under top-level `secrets:` and reference `$secrets.<name>` from each component. `generator: port` is exempt, because a port is an allocation, not an identity (D-49). Warn-only: `valid` and the exit code are unchanged.
