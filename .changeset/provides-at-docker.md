---
"@launchfile/docker": minor
---

Launch a component whose `provides` entry declares `at:`, and report the names it answers at ([#547](https://github.com/launchfile/launchfile/issues/547), D-68 rule 5).

A provider sets up the names a published entry declares — routed to the entry's listener with the requested `Host`, resolved in DNS, certified where it terminates TLS — or reports each one it did not set up; a silent launch is non-conformant. This provider publishes the listener's port with nothing in front that routes by host name, so every request that reaches the port reaches the listener with its `Host` intact and only name resolution is left to the operator. It generates the component exactly as it would without `at:` and adds one warning per declaring entry: the entry, the names under the app host (`dash.localhost`, `*.localhost`), the published address requests arrive at (`localhost:18080`), and the operator's options — map the name with a hosts file or DNS, or use a provider that routes host names.

Under a supplied publication URL (`ComposeOpts.appUrl`) the component still launches. The report names the hosts under the supplied host and says that whatever routes that URL must send each name to this endpoint with its `Host` intact. It arrives in the returned `warnings`, so an orchestrator can act on it.

Output is byte-identical for every Launchfile that declares no `at:`.
