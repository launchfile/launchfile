---
"@launchfile/docker": patch
"@launchfile/macos-dev": patch
---

Declared secrets are redacted regardless of length.

The secret registry dropped any value shorter than `MIN_SECRET_LENGTH` (8). That floor is a heuristic against scrubbing short strings that appear by coincidence, and it is right for values the provider *infers* are secret — everything it mints is far longer, so the floor never binds there.

It was wrong for values something *declared* is a secret. An `env:` literal marked `sensitive: true` (D-18) or a value handed over on the operator channel (D-52) is sensitive because the author or operator said so, not because the provider guessed. A six-digit PIN fell under the floor, was never registered, and reached the on-disk launch-error record in plaintext (CWE-532).

`registerDeclaredSecret` applies no length floor and is what `registerSensitiveEnv` and `registerSuppliedEnv` now use. The empty string is still rejected — an empty separator would splice `[REDACTED]` between every character. `registerSecret` and its floor are unchanged for inferred values.
