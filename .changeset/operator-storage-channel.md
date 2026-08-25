---
"launchfile": minor
"@launchfile/docker": minor
---

The D-50 operator-storage channel: repeatable `--storage <volume>=<path>` (and `<component>.<volume>=<path>` when the name is ambiguous) hands a `content: operator` volume its host content at `up` time. `@launchfile/docker` binds the supplied path into the volume, or refuses loudly: a marked volume with no supplied path, or a supplied path that is absent or unreadable on the host, stops the launch before anything starts — the provider never papers over a missing supply by creating an empty volume (D-52's fabrication rule, in storage form). The macOS native provider refuses `--storage`.

**Behavior change:** a Launchfile carrying `content: operator` now refuses to `up` without a supplied path. The marker did not exist before this release, so no existing Launchfile is affected.
