---
"@launchfile/macos-dev": patch
---

`up` and `status` print the supplied publication URL for the primary component (#386, D-58).

With an `appUrl` set — on this run or recorded by an earlier one — the "is running at" summary and the `status` "Components:" list show that URL, as stored, on the primary component: the one `$app.*` reads (a declared `https-origin` component, else the first with an `exposed: true` endpoint). Every other component keeps this provider's own `http://localhost:<port>` (D-58 rule 4). With no URL supplied, output is unchanged.

`LaunchState` gains `primaryEndpoint`, recorded at `up` so `status` places the URL on the same component without reading the Launchfile. `componentAddress`, `summaryLines` and `statusLines` are exported as the one address definition both printouts share; `primaryComponent` is exported from the env writer. State files without the field load as before.
