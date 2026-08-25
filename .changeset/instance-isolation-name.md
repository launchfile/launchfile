---
"launchfile": minor
"@launchfile/docker": minor
---

`--name <label>` isolates a deployment (D-55). An unnamed `up` and each `--name <label>` from the same source are now distinct deployment instances: the effective slug becomes `<base>-<label>` and keys the state directory, compose project, network, volumes, and persisted host ports, so two instances of one app never share or clobber each other's state. The deployment index is keyed by (source, name), and a bare `down`/`status`/`logs` that matches more than one instance lists them instead of guessing. `--name` requires a value, and the macOS native provider refuses the flag rather than pretending to isolate.

**Behavior change:** an `up` that finds existing state recorded from a *different* source (any source type) now refuses to adopt it, with the remedies in the message — previously it silently adopted or clobbered the same-named stack. Re-running `up` from the same source is unaffected.

Also fixes #248: CLI flag parsing no longer consumes a value flag's argument as the positional target, so `launchfile up --name blue` no longer treats `blue` as the app to deploy.
