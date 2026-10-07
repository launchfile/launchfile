---
"@launchfile/macos-dev": patch
---

`.env.local`, the per-component `.launchfile/env/*.env` files and `state.json` are now written through `writePrivateFile`, which tightens the open handle to `0o600` before writing (#683, CWE-276). `writeFile`'s `mode` option applies only when it creates the file, so a `.env.local` left at `0o644` by an earlier version stayed world-readable in the project root on every `up`. `.launchfile/env` is also chmodded to `0o700` after each `mkdir`, so `writeAllEnvFiles` no longer depends on `ensureDirs` having run first.
