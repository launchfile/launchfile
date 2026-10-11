---
"@launchfile/macos-dev": patch
"launchfile": patch
---

`launchfile up --native` now fails when a component's process exits before it comes up, instead of printing "All components started" and exiting 0. The error names each component and its exit code, or the signal that killed it. A component with `health:` fails if its process exits before the check passes, exit 0 included. A component without `health:` fails if it exits non-zero within 2s. Components that did start stay running and are recorded, so `launchfile status` and `launchfile down` still reach them.
