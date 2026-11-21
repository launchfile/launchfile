---
"@launchfile/aws": patch
---

`health` is recorded as mapped only for a component that gets an ALB target group (#734). A component that is translated but not exposed, so it gets no target group, now records a `nice-to-have` gap for `health`, because no health check runs for it. A component skipped before compute (such as an image-only component) keeps its single `workaround` row for `health` and gets no second one. An empty `health.path` (or `health: ""`) reads as absent, and an absent path is no longer recorded as mapped: the target group probes `/` and records a `workaround` gap, instead of emitting `path = ""`. This changes what 0.6.2 shipped for a `start_period`-only health block: it was recorded as mapped, and it now records this `workaround` gap.
