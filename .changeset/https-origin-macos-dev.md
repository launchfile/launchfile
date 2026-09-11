---
"@launchfile/macos-dev": minor
---

Refuse a component whose `requires:` declares an `https-origin` (D-next rule 5).

This provider has no edge and no orchestrator-facing publication channel ([#294](https://github.com/launchfile/launchfile/issues/294)), so it can neither provision a public HTTPS origin nor accept a supplied one. It refuses — which PROVIDERS.md §10 item 5 makes conformant — and the refusal is the removal: the component is dropped from the run before anything is installed, wired, registered or started, exactly as for an ungrantable host capability. A `supports:` entry is not refused; the component runs and the un-granted dependency is noted.

New exports: `refusedHttpsOrigins(launch)` and `applyHttpsOriginRefusals(launch)`.
