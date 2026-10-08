---
"@launchfile/macos-dev": patch
---

`launch down` and `launch status` now refuse `--component` (bare and `=` forms) as well as `--components`, and exit 1 before the provider runs (#414). Previously `launch down --component api` exited 0 and stopped every component. When both spellings appear, the message names `--components`.
