---
"@launchfile/macos-dev": patch
---

Fix `.launchfile/` state directories (`env`, `storage`, `tmp`, `logs`, `data`) staying world-readable when the directory already existed (CWE-276). `ensureDirs` passed `mode: 0o700` to `mkdir`, but `mkdir`'s mode only applies when it creates the directory — a directory left at a looser mode by an earlier Launchfile version, a permissive umask, or a manual `mkdir` stayed at that mode forever. `ensureDirs` now `chmod`s each directory unconditionally after `mkdir`, mirroring the retrofit already shipped in `packages/launchfile/src/state/errors.ts`. Also adds the mode to the two other `.launchfile/env` `mkdir` call sites for consistency (issue #252).
