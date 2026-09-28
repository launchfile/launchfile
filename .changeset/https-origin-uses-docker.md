---
"@launchfile/docker": patch
---

Leave a `supports:` entry of type `https-origin` unfulfilled when it declares a use the supplied origin does not cover, instead of aborting generation ([#536](https://github.com/launchfile/launchfile/issues/536), D-65 rule 4).

The component deploys, the entry's `set_env` bindings are omitted, and a warning names each uncovered use token. A `requires:` entry with the same shortfall still refuses its component (D-64). Output is byte-identical for every Launchfile whose `https-origin` entries declare no `uses:`.
