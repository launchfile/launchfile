---
"@launchfile/docker": patch
---

Resolve `$app.*` to the empty address when the component that declares the app's `https-origin` entry is refused ([#494](https://github.com/launchfile/launchfile/issues/494), D-next).

The entry still names the primary after its component is refused (D-60 rule 3), and the primary has no address: `$app.url`, `host`, `port`, `authority` and `scheme` resolve `""` and `tls` resolves `false` — never `http://localhost:<port>` for a service this provider does not generate, and never the supplied URL that failed to satisfy the entry. `$app.endpoints.<primary>.*` reads the same value from the same derivation (D-63 rule 2), and the compose environment, `bootstrap` and `release` agree. Surviving siblings keep their own addresses; `$app.name` is unchanged.

`computeAppContext` and `computeAppProperties` change value in that one case only. Output is byte-identical for every Launchfile whose declaring component launches.
