---
"@launchfile/sdk": minor
"@launchfile/docker": minor
"@launchfile/macos-dev": minor
"launchfile": patch
---

## Features

- **sdk**: `$app.*` resolver context (D-33) — platform-injected app properties (`$app.url`, `$app.host`, `$app.port`) now resolve alongside `$resources` in Launchfile expressions.
- **sdk**: pipe transforms for encoding (D-32) — secrets and refs can be piped through `|base64`, e.g. `${secrets.app-key|base64}`, required for Laravel-style `APP_KEY` formats.
- **docker provider**: populates `$app.*` in the resolver context so docker-compose generation can reference app properties (D-33).
- **macos-dev provider**: populates `$app.*` in the resolver context so local macOS runs can reference app properties (D-33).

## Alignment

All four packages release together at 0.2.0 via the linked group in `.changeset/config.json`. `@launchfile/macos-dev` catches up from 0.1.4 and the CLI advances from 0.1.9. Internal dependency ranges (sdk, docker) are pinned to `^0.2.0` in every consumer.
