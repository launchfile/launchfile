---
"@launchfile/macos-dev": patch
---

A declared primary whose component is refused resolves the empty `$app.*` address whatever refused it (D-72, D-next, #588). One refusal set (`refusedComponents`, the union of the five per-cause helpers) is read before `up`'s refusals remove anything; `env` and `bootstrap` compute it from the file and the recorded publication context. Before, only the `https-origin` scheme check emptied the address, and a `supports:` primary was never refused. `declaredPrimary` now takes the refusal set in place of `appUrl`. `--with-optional` is not recorded in state, so a certificate refusal (D-61 rule 5) is decided by `up` alone.
