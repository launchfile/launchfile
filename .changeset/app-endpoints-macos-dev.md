---
"@launchfile/macos-dev": patch
---

`$app.endpoints.<name>.*` resolves `""` for every property on this provider, and `up` says so (#463, D-next rule 4, #294).

The allocator hands out one port per component, not one per endpoint, so there is no per-endpoint address to publish — the primary's included; `$app.*` keeps its own routing answer. `computeAppEndpoints(launch)` registers the empty answer for every named published endpoint on the resolver context (`buildResolverContext` takes it as a fifth argument), and `up` warns once naming the endpoints the file references.
