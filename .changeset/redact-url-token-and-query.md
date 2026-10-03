---
"@launchfile/docker": patch
"@launchfile/macos-dev": patch
---

`redactSecrets` masks two more ways a URL carries a credential ([#575](https://github.com/launchfile/launchfile/issues/575), D-18). A userinfo with no password — `https://<token>@host` — is masked whole, and every value in a URL's query string is masked with its name kept, so `?token=abc&v=2` prints as `?token=[REDACTED]&v=[REDACTED]`. Parameters without `=`, fragments, and scp-style `git@host:a/b` remotes are unchanged. Both patterns keep the bounded, linear-time scan. The docker provider's foreign-source refusal and dry-run warning mask the recorded and current source URLs; the raw URL the D-55 comparison and the state file use is not changed.
