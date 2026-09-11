---
"@launchfile/docker": minor
---

Activate a certificate binding, or refuse before launch (D-next rule 5).

Selection is arrival through `ComposeOpts.resources` — the D-56 supplied-resource channel every other optional resource already uses here, keyed by the certificate entry's `name ?? type`. Three states, no fourth:

- **not selected** — the component deploys its declared HTTP baseline, the binding's `set_env` is absent, and the un-granted dependency is noted (D-8);
- **selected and satisfied** (`cert_file` and `key_file` both supplied) — the binding's `set_env` is written after `env:`, so it wins over a same-named `env:` declaration (PROVIDERS.md §7), and the entry's effective protocol becomes `https`;
- **selected but unsatisfied**, either property missing — the component is **refused before launch** with a message naming the entry and what is missing. Never a fall back to HTTP.

`$components.<name>.url` and the provider's own `$app.url` now read the **effective** protocol: a sibling of a TLS-active component gets `https://…`. An orchestrator-supplied `appUrl` still wins (D-58 rule 5). Output is byte-identical for every Launchfile that declares no `tls:`.

`key_file` — and every `*_key` / `*_key_file` property name — now registers with the redactor whatever its vocabulary membership. Registering `certificate` moved `key_file` *inside* a vocabulary, which would otherwise have switched its fail-closed redaction off and let private-key paths reach diagnostics (CWE-532). D-56 rule 3 still stands: no path is opened, parsed or probed.
