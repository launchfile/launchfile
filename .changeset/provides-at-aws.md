---
"@launchfile/aws": minor
---

Report a `provides` entry that declares `at:` unmapped on `translate` ([#547](https://github.com/launchfile/launchfile/issues/547), D-68 rule 5, PROVIDERS.md §10 items 5 and 8).

A provider provisions every declared name or refuses the component. This probe emits one ALB default action per listener and no DNS record, host-header rule or certificate, so it covers no value; on `translate` there is no launch at which to refuse, so each declaring entry is listed as a `provides.at` blocker gap on its component, naming the entry and every declared value. Nothing is emitted that would make the declaration look covered.

The HCL and the rest of the ledger are identical for every Launchfile that declares no `at:`.
