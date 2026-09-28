---
"@launchfile/docker": patch
"@launchfile/macos-dev": patch
---

Redact `BootstrapResult.command` before returning it. Both providers echoed the bootstrap command through `redactSecrets` and then returned the same string unscrubbed on a public export, so a resolved `$secrets.*` value or resource password reached any consumer that printed or serialized a bootstrap result. The field now carries the redacted form on both the executed and the unrunnable path; the command the shell actually runs is unchanged, and `captures` is untouched.
