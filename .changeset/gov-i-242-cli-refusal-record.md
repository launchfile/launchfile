---
"launchfile": patch
---

`launchfile up` writes a failure record for a D-52 unsupplied-`required:` refusal before it prints the refusal and exits 1 (#242). `launchfile diagnose` then shows the refusal — phase `resolve`, the unsupplied component and variable names — as the current failure; the record is superseded by the next failure and cleared by a successful `up`, like every other record.
