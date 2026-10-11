---
"@launchfile/macos-dev": patch
---

The sqlite provisioner now refuses a symlinked data path (#388). Before creating `.launchfile/data/sqlite` it checks, without following links, that `.launchfile`, `.launchfile/data` and `.launchfile/data/sqlite` are absent or real directories, and after the mkdir it confirms the directory resolves to itself under the real project root — the anchor `destroy()` already uses (#370). A refused resource is skipped so the others still provision; `up` then exits 1 and names each refused required resource once, however many components share it. A refused optional resource is skipped and the run continues (D-8).
