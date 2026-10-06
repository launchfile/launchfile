---
"launchfile": patch
---

`~/.launchfile/deployments/` and each per-deployment directory are set to `0o700` on every write, and `index.json` is written atomically at `0o600` (a fresh temp file renamed over the old one), so a pre-existing world-readable index or directory is tightened rather than left as found (CWE-276, #408). The atomic write also stops two concurrent `launchfile` commands from tearing the index. The helpers are shared with the launch-error records in `state/errors.ts`.
