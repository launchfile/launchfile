---
"@launchfile/macos-dev": patch
---

`up` now saves a postgres or mysql resource's record to `.launchfile/state.json` before it creates the database role or user (#670). A failure later in the same `up` no longer loses the generated password, so the next `up` reuses it instead of minting one the existing role rejects.
