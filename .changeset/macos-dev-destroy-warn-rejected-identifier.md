---
"@launchfile/macos-dev": patch
---

`launch down --destroy` now warns when it leaves a postgres or mysql database or user in place because its name in `.launchfile/state.json` is not a safe identifier. The warning never prints the rejected value or the stored password. The exit code is unchanged.
