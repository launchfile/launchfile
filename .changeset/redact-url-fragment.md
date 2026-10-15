---
"@launchfile/docker": patch
"@launchfile/macos-dev": patch
---

`redactSecrets` masks the values in a URL fragment ([#628](https://github.com/launchfile/launchfile/issues/628), D-18, D-71), with the same rule as a query string: `https://host/cb#access_token=abc&state=xyz` prints as `#access_token=[REDACTED]&state=[REDACTED]`. A fragment with no `=` — a D-43 baseline ref such as `#develop` or `#<sha>` — is unchanged, and so is a `#` outside a URL (a shell comment, a CSS colour). The scan stays linear.
