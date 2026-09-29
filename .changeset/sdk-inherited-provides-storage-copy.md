---
"@launchfile/sdk": patch
---

`readLaunch` gives each component its own copy of inherited `provides` and `storage`. Components that omit these fields previously shared the top-level array and map by reference, so mutating one component's entry changed every other inheriting component. The array, map and each entry are now copied; nested values such as `set_env` stay shared.
