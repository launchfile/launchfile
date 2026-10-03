---
"@launchfile/macos-dev": patch
---

`up --dry-run` now prints "would be reachable at" instead of "is running at" in its component summary (#642). Nothing has started in a dry run, so the old wording claimed a state that did not exist. A real `up` is unchanged.
