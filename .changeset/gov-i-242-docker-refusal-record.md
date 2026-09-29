---
"@launchfile/docker": patch
---

An unsupplied `required:` variable now refuses the launch with a `LaunchError` (#242, D-52). The refusal carries a failure record in phase `resolve` whose `unsupplied[]` names each blocking component and variable — names only, never a value — so `launchfile diagnose` reports the refusal instead of an older, unrelated failure. The message and the exit code are unchanged. Every value the operator channel supplies for a required variable is registered with the redactor as it arrives, `sensitive: true` or not, so a captured failure cannot carry it (D-18).
