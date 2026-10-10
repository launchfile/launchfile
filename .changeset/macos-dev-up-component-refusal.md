---
"@launchfile/macos-dev": patch
---

`launch up` now refuses `--component` (bare and `=` forms) and exits 1 before anything starts (#658). Previously `launch up --component web` exited 0 and started every component. `--components` is unaffected. Scripts that relied on exit 0 for the singular spelling now fail, the same break D-67 accepted for the unified `launchfile` CLI.
