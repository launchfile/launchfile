---
"@launchfile/docker": patch
---

`generator: port` draws from `crypto.getRandomValues` instead of `Math.random()`.

A `generator: port` value can be declared under `secrets:`, where the docker provider stores it in the secrets map, persists it to state and redacts it like any other secret (`compose-generator.ts`). `Math.random()` is not a security primitive, so the port now comes from the same CSPRNG as `generator: secret` and `generator: uuid`. The range is unchanged: 10000–64999, and rejection sampling keeps it uniform.

Closes code-scanning alert #53 (`js/insecure-randomness`, high).
