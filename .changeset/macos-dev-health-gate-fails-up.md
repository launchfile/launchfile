---
"@launchfile/macos-dev": patch
---

Fix `launchfile up --macos-dev` exiting 0 against an app that never came up. The provider polled a component's `health:` only to order the start of something that declared `depends_on: {condition: healthy}` on it, and then threw the result away — so a component nothing depended on was never checked at all, and a dependency that timed out still let its dependent start. SPEC.md § Failure semantics says a component that never becomes healthy fails the invocation, and the docker provider already does that.

After every component has started, the provider now polls each declared `health:` check and fails `up` naming every component that did not pass within the 60s budget, and the probe it was asked (`GET http://localhost:<port><path>` or the `command`). A `condition: healthy` gate fails the same way — the dependent is not started — and it fails closed when the dependency declares no `health:` or a `path` check has no port to poll, instead of treating an uncheckable dependency as satisfied. Processes that did start are left running and their pids are recorded in state, so `status`, `logs` and `down` still reach them. An app whose checks pass, and an app declaring no `health:`, behave as before.
