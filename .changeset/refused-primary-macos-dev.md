---
"@launchfile/macos-dev": patch
---

Keep a refused `https-origin` component as the app's primary and resolve `$app.*` to the empty address ([#494](https://github.com/launchfile/launchfile/issues/494), D-next).

`up` reads the declared primary before its refusals remove the component from the run, so a surviving sibling's port no longer becomes `$app.url`. The primary has no address: `$app.url`, `host`, `port`, `authority` and `scheme` resolve `""` and `tls` resolves `false`, in the env every surviving component receives; `env` and `bootstrap` compute the same. `$app.name` is unchanged, and so is every Launchfile whose declaring component launches.
