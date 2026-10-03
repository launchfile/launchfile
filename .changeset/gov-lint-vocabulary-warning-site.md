---
"@launchfile/sdk": patch
---

The `lintLaunch` warning for a resource property outside the standard vocabulary (D-46) now names where it comes from: the component (`(top-level)` for a single-component file), the resource (`name (type)`, or just the type when the entry has no name), and the env key. Before, two bad references in different places produced byte-identical warnings (#183). New format: `api: cache (redis): REDIS_URL: "$hoost" is not in the standard vocabulary (known: ...)`. A property repeated within one env value now warns once. Still warn-only: `valid` and the exit code are unchanged.
