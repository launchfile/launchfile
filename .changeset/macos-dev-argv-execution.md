---
"@launchfile/macos-dev": patch
---

Commands are built as an argument array and run through `execFile`, so a value spliced into a command can no longer be read as shell syntax (CWE-78).

The runtime installers were the live case: `detectVersion()` returns the verbatim contents of `.nvmrc`, `.node-version`, `package.json` engines.node, `.ruby-version` or `.python-version` from the target repo, and `install()` interpolated that string into a command run by `/bin/sh -c`. A repository could therefore run arbitrary commands during `launchfile up` — including under `--no-build`, which skips the app's own `install`/`build` commands but not the runtime install step.

`shell()` now takes `(cmd, args[], opts)`, matching `@launchfile/docker`. Author-written command strings — `commands:`, `health:`, `release:` — keep their shell, which is their documented contract, through the separate `shellScript()` entry point.

Also fixes an unrelated bug in the same code: the rbenv/pyenv installed-version check matched with `grep`, treating the version as a regex, so every `.` matched any character and an unrelated installed version could satisfy the request and skip the install.
