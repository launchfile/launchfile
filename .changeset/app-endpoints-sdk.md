---
"@launchfile/sdk": minor
---

`$app.endpoints.<name>.{url, host, port, scheme, authority, tls}` — a public address for every named published endpoint (#463, D-63).

The resolver gains one nested form under the reserved `$app.*` prefix. It reads a sibling field, `ResolverContext.appEndpoints`, keyed by `provides[].name`, never a map inside `context.app`; only the four-segment form addresses a value, and every other shape — no name, no property, an unknown name or property, an endpoint the provider registered nothing for — resolves `""` (L-4). `AppEndpointProperties`, `APP_ENDPOINT_PROPERTIES` and `UNPUBLISHED_APP_ENDPOINT` (the all-`""` answer a provider registers when it publishes no per-endpoint address) are exported.

`validate` warns on each reference that resolves `""`: `$app.endpoints` with no name, `$app.endpoints.<name>` with no property, a name no `provides` entry carries, a named endpoint that is not `exposed: true`, and a property outside the six. `appEndpointReferences(launch)` lists a file's references so providers can name the endpoints an app asks for.

One new validation error: a `provides[].name` declared on two components is refused naming both — an endpoint name is app-wide now that `$app.endpoints.<name>.*` addresses it by name alone. No tracked catalog Launchfile declares one, so nothing that validates today starts failing.
