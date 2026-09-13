---
"launchfile": patch
---

`launchfile` now refuses a long flag it does not declare — on every verb,
before anything runs. `launchfile up . --storagex vol=/srv/vol` used to launch
normally with exit 0, the typo'd flag silently dropped and the token after it
read as the target; it now exits 1 with `no such flag --storagex — did you mean
--storage?` on stderr. The suggestion names the one nearest declared flag when
exactly one fits and is omitted otherwise; the CLI never auto-corrects. A
script that passed a stray flag and relied on exit 0 now fails. Single-dash
aliases (`-d`, `-f`) are unchanged.
