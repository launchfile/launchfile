---
"@launchfile/macos-dev": minor
---

Refuse a selected certificate binding instead of starting the component in cleartext (D-61 rule 5).

This provider has no supplied-resource channel, so it can never receive a `cert_file`/`key_file` pair and can never activate native TLS. Selection here is `--with-optional`: without it a `tls:` binding is inactive and the declared HTTP baseline is the correct deployment (D-8); with it the operator asked for TLS this provider cannot give, and the component is removed from the run with a surfaced message naming the entry — the refusal PROVIDERS.md §10 item 5 makes conformant.
