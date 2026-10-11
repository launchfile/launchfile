---
"launchfile": patch
---

The CLI now escapes argv text in its unknown-flag and unknown-command refusals (#545). ANSI escapes and other control characters are removed, and a newline or tab prints as `\n` or `\t`, so each refusal stays one stderr line and a hostile argument cannot forge output or rewrite the terminal. A bare `--` is still refused, now with `` no such flag: `--` has an empty flag name ``. Exit codes are unchanged.
