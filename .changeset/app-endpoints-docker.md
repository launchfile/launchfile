---
"@launchfile/docker": minor
---

`$app.endpoints.<name>.*` resolves for every named published endpoint, from the one derivation `$app.*` already uses (#463, D-next).

`computeAppContext(launch, hostPorts, appUrl?, activeCertificates?)` returns `$app.*` and the per-endpoint map together: the primary endpoint is found once, its `publishedAddress()` is `$app.*`, and the same six fields are its `$app.endpoints.<name>` entry, so the two cannot differ. Every other named `exposed: true` endpoint resolves from its own host port and effective listener (D-61 rule 2): an active certificate binding reads `https`; a `tcp`/`udp` endpoint has no origin, so its `url` and `scheme` are `""` and its `tls` is `false` while `host`, `port` and `authority` resolve. The compose generator, `bootstrap` and `release` all read the map, so the three sites agree.

Under a supplied `appUrl` the D-58 rule 4 fence holds: the primary resolves from it and every other named endpoint resolves `""`, with one warning naming each such endpoint the file references. Generated output is unchanged for every Launchfile that references no `$app.endpoints.*` — checked against every tracked catalog file.
