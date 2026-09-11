---
"@launchfile/sdk": patch
---

Fix D-25 field inheritance: `normalizeComponent` only applied the `?? defaults?.` fallback to 7 of the 17 fields a component can carry (`runtime`, `image`, `build`, `source`, `restart`, `platform`, `host`). The other 10 — `provides`, `requires`, `supports`, `env`, `commands`, `health`, `depends_on`, `storage`, `schedule`, `singleton` — took the component's own value with no fallback, so a top-level value was silently discarded on parse whenever a `components:` block was also present, with no diagnostic. All 17 fields now inherit consistently: a component that omits one of these fields inherits the top-level default, and a component that declares its own value (including an empty one) takes it whole, per D-25's whole-value-replacement rule. Parse output changes for any Launchfile that pairs a top-level value in one of the 10 fields with a `components:` block — 0 of 113 shipped catalog Launchfiles use that shape today.
