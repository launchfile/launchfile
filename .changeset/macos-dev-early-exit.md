---
"@launchfile/macos-dev": patch
---

`up` fails for a component that exits while its log file is closing, instead of reporting it as started; `down` no longer waits 10 seconds on a process that already exited (#799).
