---
"@launchfile/docker": patch
---

`up` and `status` print the supplied publication URL for the primary endpoint (#386, D-58).

With an `appUrl` set — on this run or recorded by an earlier one — the "is running at" summary and the `status` "Access URLs" list show that URL on the primary endpoint's key, as stored — the same string `$app.url` resolves to. Every other key keeps this provider's own `localhost` address (D-58 rule 4), and a `ws`, `tcp`, `udp` or `grpc` primary keeps its own form — an `http`/`https` URL asserts nothing about those listeners. With no URL supplied, output is unchanged.

`DockerState` gains `primaryEndpoint`, the `ports` key `$app.*` reads, recorded at `up` so `status` can place the URL without re-deriving the primary from a Launchfile it never loads. `endpointAddress` takes an optional `appUrl` third argument; `summaryLines` an optional fifth `publication` argument; `statusLines` is new. State files without the field load as before.
