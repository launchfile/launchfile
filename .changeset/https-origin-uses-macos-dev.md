---
"@launchfile/macos-dev": patch
---

Grade the declared uses of an `https-origin` entry before wiring it, instead of aborting the launch ([#536](https://github.com/launchfile/launchfile/issues/536), D-64, D-65 rules 3 and 4).

A `requires:` entry declaring a use this provider cannot cover refuses its component before anything is provisioned or started; sibling components still launch. A `supports:` entry with the same shortfall runs degraded: its `set_env` bindings are absent and a warning names each uncovered use token. Launchfiles whose `https-origin` entries declare no `uses:` behave as before.
