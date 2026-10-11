---
"@launchfile/docker": patch
---

A `requires:` `https-origin` entry's declared `uses:` are now graded against the origin's own property map (`{ url }`), the map its wiring reads, instead of a same-keyed `resources` entry the provider ignores (#589). The refusal for an uncovered use now gives the same reason the `supports:` mood gives for the same token. Outcome unchanged: `https-origin` registers no uses, so every declared token was already refused.
