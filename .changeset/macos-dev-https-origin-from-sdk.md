---
"@launchfile/macos-dev": patch
---

`httpsOriginSatisfied` and `REFUSED_PRIMARY_ADDRESS` now come from `@launchfile/sdk` (#587) and are re-exported unchanged, so imports from `@launchfile/macos-dev` keep working. No behaviour change: the predicate and the address are the same values this provider defined itself.
