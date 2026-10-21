---
"@launchfile/macos-dev": patch
---

`up` no longer misses a component that exits within moments of starting. The process manager attached its `exit` listener only after closing the log descriptor it hands the child; a component that exited during that close (a fast `exit 1` on a loaded host) was never seen, so `up` counted it as up once the watch window closed, and shutdown waited on an exit that had already happened. The listener is now attached before anything awaits (#526's exit gate).
