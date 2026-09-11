---
"@launchfile/aws": minor
---

Report a `certificate` entry unmapped on `translate` (D-61 rule 5, PROVIDERS.md §10 items 5 and 8).

A certificate activates the app's **own** listener, and this probe has no way to place one inside the task; on `translate` there is no launch at which to refuse, so the entry is listed as a nice-to-have gap naming the listener it binds and the certificate entry. Terminating TLS at the ALB is a different arrangement and does not fulfil the entry (D-61 rule 4), so nothing is emitted that would make the declaration look satisfied.
