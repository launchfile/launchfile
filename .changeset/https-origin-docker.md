---
"@launchfile/docker": minor
---

Satisfy or refuse an `https-origin` entry, and let a declared one fix the app's primary endpoint (D-next).

This provider runs no edge of its own, so the only satisfaction it can offer is an origin the orchestrator already owns, supplied through `ComposeOpts.appUrl` — which for this type IS the supplied-resource channel (D-56), not a second one. With an `https://` value the entry's `url` resolves to it and its `set_env` is wired; with an `http://` one, or none, a `requires:` entry **refuses the component** with a surfaced `refused: …` message naming the entry and the supplied scheme, and a `supports:` entry is left unfulfilled with a note. No branch makes a network request: D-56 rule 3 stands, and the provider does not verify the origin exists.

`computeAppProperties` now resolves `$app.*` from the endpoint an `https-origin` entry names, when the file declares one, instead of from the first published endpoint in declaration order. **Declaration** fixes it, not fulfillment, so `$app.*` does not change value with what the provider can satisfy. `$components.<name>.url` is untouched. Apps that declare no such entry keep the positional answer, byte for byte.

A new export, `declaredPrimaryEndpoint(launch)`, returns that endpoint (component, name, allocation key, container port) or `undefined`.
