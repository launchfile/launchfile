---
"@launchfile/aws": patch
---

A component whose `health` block declares only `command` no longer gets an invented `/` ALB health check recorded as mapped (#718). The probe now records a `workaround` conformance gap for `health` and emits the target group without a `health_check` block. `health.path` is mapped as before.
