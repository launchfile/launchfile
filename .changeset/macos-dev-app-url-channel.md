---
"@launchfile/macos-dev": minor
"@launchfile/sdk": minor
"@launchfile/docker": patch
---

macos-dev gains the orchestrator-facing publication channel (D-58)

`launchUp({ appUrl })` supplies the public URL of the app's primary endpoint
when routing is owned upstream, and `$app.*` resolves from it instead of
`http://localhost:<port>`. The value is persisted in `.launchfile/state.json`,
so `env` and `bootstrap` answer with it and a later run that omits the option
keeps it; supplying a different one replaces it.

`https-origin` (D-60) rides that channel, as it does under `@launchfile/docker`:
an `https` `appUrl` satisfies a required entry and resolves its `url` to
`$app.url`; with no URL, or one whose scheme is not `https`, the component is
refused with the same two reasons docker gives. A declared `https-origin`
entry also names the app's primary endpoint for `$app.*` (D-60 rule 3).

The SDK now owns D-58's URL contract — `normalizeAppUrl`, `InvalidAppUrlError`,
`suppliedAppAddress`, and `suppliedAppProperties` — so both providers refuse a
malformed value with the same message instead of carrying two copies of a spec
rule. `@launchfile/docker` re-exports the first two and its `publishedAddress`
derives a supplied URL through `suppliedAppAddress`, so its public API is
unchanged.
