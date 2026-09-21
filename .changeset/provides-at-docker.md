---
"@launchfile/docker": minor
---

Refuse a component whose `provides` entry declares `at:` ([#547](https://github.com/launchfile/launchfile/issues/547), D-68 rule 5).

A provider provisions every declared name — routed to the entry's listener with the requested `Host`, resolved in DNS, certified where it terminates TLS — or refuses the component before launch; partial coverage and a silent no-op are both non-conformant. This provider publishes ports and routes no host names, so it covers no value. The component is refused before anything of it is emitted, through the same surfaced `refused:` warning as an unprovisionable `requires` entry (D-64), with a message naming each declaring entry and every value it declares. Sibling components still launch.

A supplied publication URL (`ComposeOpts.appUrl`) does not change this: it states the app host's address, not which `at:` values the orchestrator covers. The channel for that statement does not exist yet ([#543](https://github.com/launchfile/launchfile/issues/543)), and the message says so.

Output is byte-identical for every Launchfile that declares no `at:`.
