---
"@launchfile/macos-dev": patch
---

`.launchfile/`, each provisioned storage volume directory, and `.launchfile/data/sqlite` are set to `0o700` on every launch, not only when they are first created. `mkdir`'s `mode` applies at creation only, so a directory left by an earlier version or a looser umask stayed world-readable (CWE-276, #408). `ensureDirs` already did this for its five subdirectories (#382).
