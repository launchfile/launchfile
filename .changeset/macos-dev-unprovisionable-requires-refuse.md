---
"@launchfile/macos-dev": minor
---

Refuse a component whose `requires` entry names a resource type this provider has no provisioner for, instead of warning and starting it without the resource ([#461](https://github.com/launchfile/launchfile/issues/461), PROVIDERS.md §10 item 5). `launch up` previously printed `! No provisioner for resource type: <type> (skipping)` and went on to install, wire and start the component. The component is now removed from the run before anything is provisioned, installed, wired or started — the same shape as this provider's `https-origin` refusal — with a message naming the component and the entry. Sibling components still run. This provider has no supplied-resource channel, so a type it does not provision (`kafka`, `clickhouse`, `mongodb`, among others) can only be refused. `supports:` entries and host-capability entries are unchanged.
