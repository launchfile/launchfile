---
"@launchfile/docker": patch
"@launchfile/macos-dev": patch
"@launchfile/sdk": patch
---

Bound the repetitions in the ANSI-stripping and credential-URL patterns, so a long log line can no longer stall the provider that is reading it (CWE-1333).

Two shapes were quadratic. `stripAnsi` in both providers' `bootstrap.ts` carried `\x1b\][^\x07]*\x07`: every `ESC ]` in captured stdout rescanned the whole remainder for a BEL a hostile log never supplies — 40 000 `ESC ]` pairs took 366 ms through `extractCaptures`. `CREDENTIAL_URL` in `@launchfile/macos-dev`'s redactor left the scheme repetition unbounded, so a long run of scheme-legal characters that never reaches `://` rescanned from every offset — 80 000 characters took 895 ms through `redactSecrets`. Both measured under Bun 1.4.0 on an Apple-silicon Mac; bounded, each takes under 1 ms. `@launchfile/docker`'s redactor was already bounded.

The ANSI pattern now also ends an OSC string at ST (`ESC \`) as ECMA-48 requires, not only at BEL. The unbounded class ran past an ST into the next OSC, so an OSC 8 hyperlink lost its link text — and a `commands.*.capture` pattern looking for the URL in that text captured a string with escape bytes still in it. It now captures the URL.

The CSI parameter bound is 64 rather than 32. One SGR that sets a truecolor foreground and background together — `ESC [ 38;2;255;255;255;48;2;240;240;240 m` — carries 33 parameter bytes, and a sequence past the bound is not stripped at all. `@launchfile/sdk` carries the same pattern and takes the same bound, so all three copies stay identical.

The scheme bound excludes no URL: the pattern is unanchored, so against a scheme longer than the bound the match simply starts further into it and the password still redacts.
