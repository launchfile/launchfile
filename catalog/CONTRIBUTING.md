# Contributing to the Catalog

## Adding a New App

1. Create a directory: `catalog/apps/<app-name>/`
2. Add a `Launchfile` (no extension) with the app's deployment descriptor
3. Open a PR with:
   - The Launchfile
   - A brief description of the app and what services it needs
   - Confirmation that you tested it validates against the schema

## Launchfile Template

```yaml
# yaml-language-server: $schema=https://launchfile.dev/schema/v1
version: launch/v1
name: <app-name>

image: <registry>/<image>:<tag>

provides:
  - protocol: http
    port: <port>
    exposed: true

requires:
  - type: postgres
    set_env:
      DATABASE_URL: $url

storage:
  data:
    path: /app/data
    persistent: true

health: /health
```

## Guidelines

- Use the official Docker image when available
- Prefer `set_env` with `$url` for database wiring (covers most cases)
- Add `health` when the app has a health endpoint
- Mark user-provided env vars as `required: true`
- Mark secrets as `sensitive: true`
- For multi-component apps, use `depends_on` with `condition: healthy`

## Updating an Existing App

If an app's configuration changes (new env vars, different ports, etc.), update the Launchfile and note what changed in the PR description.

## Reporting Gaps

If the Launchfile format can't fully express an app's requirements, document the gap in your PR and we'll track it in [GAPS.md](GAPS.md).
