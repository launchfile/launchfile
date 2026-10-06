---
"@launchfile/aws": patch
---

A component whose `health` block declares only `command` no longer has its `/` ALB health check recorded as mapped (#718). The probe now records a `workaround` conformance gap for `health`; the target group keeps its `/` probe with the `200-399` matcher. Every other `health` block, including one with only `start_period`, is mapped, and `health.path` is used as before.
