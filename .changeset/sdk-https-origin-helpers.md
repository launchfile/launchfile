---
"@launchfile/sdk": minor
---

Export `httpsOriginSatisfied(appUrl)` and `REFUSED_PRIMARY_ADDRESS` (#587). Both `@launchfile/docker` and `@launchfile/macos-dev` carried a hand-copied definition of each: the D-60 rule 5 predicate that decides whether a supplied publication URL satisfies an `https-origin` entry (its scheme is `https`; syntactic only), and the D-72 `$app.*` address of a primary whose component is refused (every field `""`, `tls` reading `"false"`). One definition in the SDK, beside `suppliedAppAddress` and `UNPUBLISHED_APP_ENDPOINT`, is what P-5 asks for: the same file must be refused, and resolve the same `$app.*`, under every provider.
