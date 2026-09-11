---
"launchfile": minor
---

`launchfile bootstrap --reveal` prints the captures an app marks `sensitive` (#464).

Masking stays the default: a sensitive capture prints as `***` followed by one line naming the flag. `--reveal` is a bare boolean — no alias, no value, no terminal heuristic — and reveals every sensitive capture of that one run on either provider. It changes what the terminal prints only; the provider registers the value with its redactor either way, so it never reaches a log, a state file, or the failure record `diagnose` shows.
