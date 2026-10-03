---
"@launchfile/macos-dev": minor
---

A declared primary whose component is refused resolves the empty `$app.*` address whatever refused it (D-72, D-next, #588). One refusal set (`refusedComponents`, the union of the five per-cause helpers) is read before `up`'s refusals remove anything; `up` records `--with-optional` in state beside the publication context, and `env` and `bootstrap` compute the set from the file and those recorded inputs, so a certificate refusal (D-61 rule 5) empties `$app.*` on all three verbs. Before, only the `https-origin` scheme check emptied the address, and a `supports:` primary was never refused. `declaredPrimary` now takes the refusal set in place of `appUrl`.
