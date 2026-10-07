---
"@launchfile/docker": patch
---

The provider state directory `~/.launchfile/docker/<slug>/` is set to `0o700` on every `saveState` and `ensureStateDir`, not only when it is first created. `mkdir`'s `mode` applies at creation only, so a directory left by an earlier version or a looser umask stayed world-readable (CWE-276, #408).
