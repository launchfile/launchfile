---
"@launchfile/macos-dev": patch
---

Fixed `launch down` signalling a process whose live start time is *earlier* than the recorded spawn — the identity check now compares the absolute difference, so a recycled pid, a backward clock jump, or a state file from another run all read as a mismatch and the process group is left untouched.
