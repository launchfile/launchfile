---
"launchfile": minor
"@launchfile/macos-dev": minor
---

Wire the D-41 component selector through to the providers as `--components <name>[,<name>…]` on `launchfile up` / `launchfile dev` and on the macOS provider's own `launch up`. Both providers already resolved a selector into the D-41 start-set through the SDK's `selectionClosure`; no entry point ever passed one, so every `up` started the whole app. The names are forwarded verbatim, so an unknown one still gets the provider's existing `Cannot select:` refusal. The flag is comma-separated and repeatable; omitting it starts every component, exactly as before.

`--component` (singular) stays `bootstrap`'s single-component limiter. The CLI's flag table is global, so a verb that does not read a selector would still consume its value and drop it: every command now refuses a spelling it does not implement instead. `up`/`dev` refuse `--component`, `bootstrap` refuses `--components`, and `down`/`status` refuse both rather than acting on every component while the operator named one.
