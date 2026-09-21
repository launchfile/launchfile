---
"@launchfile/macos-dev": minor
---

Refuse a component whose `provides` entry declares `at:` ([#547](https://github.com/launchfile/launchfile/issues/547), D-next rule 5).

A provider provisions every declared name or refuses the component before launch. This provider starts processes on local ports and routes no host names, so it covers no value: the component is removed from the run before anything is provisioned, installed, wired or started, with a stderr message naming each declaring entry and every value it declares — the same removal-is-the-refusal path as an unprovisionable `requires` entry (D-64). Components that declare no `at:` still start; when none is left, `up` exits non-zero.

A publication URL (`LaunchUpOpts.appUrl`, `launchfile up --url`) does not change this: it states the app host's address, not which `at:` values an orchestrator covers, and the channel for that statement does not exist yet ([#543](https://github.com/launchfile/launchfile/issues/543)).

A Launchfile that declares no `at:` runs exactly as before.
