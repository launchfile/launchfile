---
"@launchfile/sdk": minor
"@launchfile/docker": minor
"@launchfile/macos-dev": minor
"@launchfile/aws": minor
---

Make the documented `$components.<component>.<endpoint>.<property>` form resolve, and stop an unknown endpoint name resolving to the wrong port.

SPEC.md has listed the four-segment named-endpoint form since D-6 gave `provides` entries a `name`, but no provider registered anything under those names — every provider built one flat `{url, host, port}` record per component from `provides[0]`. The reference did not merely fail: `resolveComponentPath` missed the `<endpoint>.<property>` key and fell back to the last path segment alone, so `$components.web.https.port` answered with the *first* endpoint's port. A sibling wired itself to a live, plausible, wrong port with nothing reported.

- `@launchfile/sdk`: the `components.*` lookup no longer falls back to the last path segment — an endpoint name nobody registered resolves to the empty string (L-4), or to a `${...:-default}`. New `endpointProperties(provides, host)` export builds the flat `<endpoint>.host` / `.port` / `.protocol` (and `.url` when the protocol names a URL scheme) keys a provider registers — from the effective listener when it is handed the active certificate set (D-61); three-segment references such as `$components.backend.url` are unchanged.
- `@launchfile/docker`, `@launchfile/aws`: register those keys for every declared endpoint at the sibling's in-network address, independent of D-27 publication — `exposed` governs the host boundary, not visibility between siblings. On docker, `<endpoint>.protocol` and `<endpoint>.url` read the effective listener (D-61): an endpoint whose certificate binding is active says `https`, as `$components.<name>.url` already does.
- `@launchfile/macos-dev`: `buildResolverContext` takes the declared components as an optional seventh argument (after the `$app.endpoints` map and the declared uses) and registers the same keys. This provider allocates one host port per component; when the allocator has moved a component off every port it declares, no declared endpoint can be named at that port, so the component registers its primary keys only.
