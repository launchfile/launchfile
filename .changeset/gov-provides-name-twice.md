---
"@launchfile/sdk": minor
---

One new validation error: two `provides` entries on one component (or at the top level) that share a `name` are refused, naming both indexes (#423, D-63 rule 4). The named-endpoint keys (`$components.<c>.<name>.*`, `$app.endpoints.<name>.*`) are looked up by name, so the later entry silently replaced the earlier one. Unnamed entries are unaffected. No tracked catalog Launchfile declares a repeated name, so nothing that validates today starts failing.
