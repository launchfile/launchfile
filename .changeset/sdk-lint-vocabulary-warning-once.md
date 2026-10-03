---
"@launchfile/sdk": patch
---

`lintLaunch` now prints each D-46 resource-vocabulary warning once per component. Before, two entries with the same `name` in one component (one shared resource under D-24) printed the identical warning twice (#669). The same warning in two different components still prints once for each component. Still warn-only: `valid` and the exit code are unchanged.
