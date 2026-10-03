---
"@launchfile/docker": minor
---

A declared primary whose component is refused resolves the empty `$app.*` address whatever refused it (D-72, D-next, #588). One refusal set (`refusedComponents`, exported) is decided before `$app.*` from the publication context, the supplied resources and the certificate plan; the compose generator applies it per component, and `planBootstraps` and `planReleases` compute it from the same inputs (they now accept `resources`). Before, only a `requires:` `https-origin` entry whose scheme check failed emptied the address, so a primary refused for a host capability, a certificate, an unprovisionable type or an uncovered use handed surviving siblings the supplied URL — an origin nothing answers at. `declaredPrimaryEndpoint` now takes the refusal set in place of `appUrl`.
