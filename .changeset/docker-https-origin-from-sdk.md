---
"@launchfile/docker": patch
---

`httpsOriginSatisfied` and `REFUSED_PRIMARY_ADDRESS` now come from `@launchfile/sdk` (#587). This provider's `src/app-url.ts` re-exports both unchanged, so its internal imports keep working. Neither name is exported from the `@launchfile/docker` package entry, before or after this change: import them from `@launchfile/sdk`. No behaviour change: the predicate and the address are the same values this provider defined itself.
