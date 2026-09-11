---
"@launchfile/aws": minor
---

Report an `https-origin` entry as unmapped on `translate`, with a reason that names the endpoint (D-next rule 5).

This probe composes `$app.*` from the ALB's `${aws_lb.main.dns_name}` — an http-only address that does not exist until apply time — so no managed service maps the entry. A `requires:` entry is now a **blocker** gap suggesting an ACM certificate and an HTTPS listener; a `supports:` entry is **nice-to-have**. Previously it fell through the generic "no managed AWS service mapping" branch, which graded a whole-app HTTPS requirement as a workaround.
