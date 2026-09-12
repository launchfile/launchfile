---
"@launchfile/aws": patch
---

Carry an author-declared `restart:` onto the generated systemd unit. `translate` never read `component.restart` and wrote `Restart=always` into every unit, so a component declaring `restart: "no"` or `restart: on-failure` got an artifact that contradicts the file it was translated from — and the conformance ledger, which promises every field is mapped, gapped, or safely ignored, never mentioned the field at all. The three Launchfile values now map through an explicit table onto `Restart=always`, `Restart=on-failure`, and `Restart=no`, and the mapping is recorded on the ledger. A component that declares no `restart:` still gets `Restart=always`, now as a stated default; the cross-provider default for an undeclared `restart:` is decided in #234.
