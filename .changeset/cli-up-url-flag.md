---
"launchfile": minor
---

`launchfile up --url <public-url>` — the operator spelling of D-58's
publication channel

An operator running behind their own Caddy, nginx, or tunnel supplies the
public URL of the app's primary endpoint on the command line, and `$app.*`
resolves from it instead of the provider's own routing answer. The flag reaches
`appUrl` on both providers, so `up`, `up --native`, and `dev` all take it.

The value is passed through untouched: the SDK's `normalizeAppUrl` stays the
only implementation of validation and normalization, and a refused value stops
the deploy with the provider's message — never a degraded or guessed `$app.*`.
Omit the flag and behavior is unchanged.
