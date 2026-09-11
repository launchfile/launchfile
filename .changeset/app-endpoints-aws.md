---
"@launchfile/aws": patch
---

`$app.endpoints.<name>.*` resolves `""` for every property on this provider, and `translate` reports it (#463, D-next rule 4, #487).

The probe fronts one load-balancer address and publishes nothing per endpoint, so every per-endpoint property is `""` — the primary's included — while `$app.*` keeps the ALB value. Each endpoint the file references lands on the conformance report as a `workaround` gap naming the component.
