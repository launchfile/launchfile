---
"@launchfile/docker": patch
---

`state.json` and the generated compose file are now written through `writePrivateFile`, which tightens the open handle to `0o600` before writing (#683, CWE-276). `writeFile`'s `mode` option applies only when it creates the file, so a file left at `0o644` by an earlier version kept that mode on every save. Both files sit in a `0o700` state directory, so this is defense in depth.
