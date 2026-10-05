---
"@launchfile/aws": patch
---

`health` is recorded as mapped only for a component that gets an ALB target group (#734). A component with `health` and no target group (not exposed, or skipped before compute, such as an image-only component) now records a `nice-to-have` gap, because no health check runs for it. An empty `health.path` (or `health: ""`) reads as absent: the target group probes `/` and the probe records a `workaround` gap, instead of emitting `path = ""`.
