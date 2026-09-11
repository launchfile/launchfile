---
"@launchfile/docker": minor
---

One derivation of a published endpoint's address (#473).

Three places used to mint the address of a host-published endpoint independently, and they had drifted. An entry declaring `protocol: https` with no certificate binding resolved `$app.url` to `http://localhost:<port>` while `status` and `up` printed `https://localhost:<port>` for that same entry — so the app was configured with one origin and the operator was told another. An active certificate binding on a declared-`http` entry drifted the other way.

`publishedAddress(effectiveProtocol, hostPort, appUrl?)` is now the single derivation, exported from the package. It returns the `host`/`port`/`url`/`authority`/`scheme`/`tls` set with the rules already ratified: the scheme is `https` exactly when the listener's **effective** protocol is `https` (D-61 rule 2), `ws` and `grpc` keep the http origin (D-60 rule 4), and a supplied `appUrl` wins outright (D-58 rules 2 and 5). `$app.*`, `endpointAddress`, and the endpoint metadata the compose generator persists all read it, so the primary endpoint's `$app.url` and its printed address are now byte-identical.

The persisted endpoint protocol is the effective one, not the declared one. Output is unchanged for every Launchfile that declares neither `protocol: https` nor `tls:`.
