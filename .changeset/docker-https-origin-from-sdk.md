---
"@launchfile/docker": patch
---

`httpsOriginSatisfied` and `REFUSED_PRIMARY_ADDRESS` now come from `@launchfile/sdk` (#587) and are re-exported unchanged, so imports from `@launchfile/docker` keep working. No behaviour change: the predicate and the address are the same values this provider defined itself.
