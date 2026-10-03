---
"@launchfile/sdk": patch
---

`lintLaunch` now prints the unrecognised-`uses` warning once per component when two same-name entries (one shared resource, D-24) declare the same bad use (#726). Before, each entry repeated the identical line. Still warn-only: `valid` and the exit code are unchanged.
