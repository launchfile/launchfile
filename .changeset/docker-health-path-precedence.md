---
"@launchfile/docker": patch
---

The Docker provider now honours `health.path` over `health.command` when a `health` block declares both, as SPEC.md requires. It previously used `command` and ignored `path`. Blocks that declare only one field are unchanged.
