---
"@launchfile/aws": minor
---

Report a `provides` entry that declares `at:` unmapped on `translate` ([#547](https://github.com/launchfile/launchfile/issues/547), D-68 rule 5, PROVIDERS.md §10 items 5 and 8).

A provider sets up the names a published entry declares or reports each one it did not set up. This probe emits one ALB default action per listener, which forwards every host name to it, and no DNS record, host-header rule or certificate. Nothing is launched on `translate`, so each declaring entry is listed as a `provides.at` gap on its component, at severity `workaround`, naming the entry and every declared value: an operator can add the records by hand.

The HCL and the rest of the ledger are identical for every Launchfile that declares no `at:`.
