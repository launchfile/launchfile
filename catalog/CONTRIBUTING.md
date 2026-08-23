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

- Prefer `set_env` with `$url` for database wiring (covers most cases)
- Add `health` when the app has a health endpoint
- Mark user-provided env vars as `required: true`
- Mark secrets as `sensitive: true`
- For multi-component apps, use `depends_on` with `condition: healthy`
- See [Image references](#image-references) below for choosing an `image:` tag

## Image references

This catalog indexes how third-party apps map onto the Launchfile format. It follows
each upstream project's own release channel — it does not re-publish or freeze
upstream images.

Write the `image:` reference in this order of preference:

1. **The narrowest stable tag upstream itself recommends** in its README or install
   docs — `louislam/dockge:1`, `ghcr.io/requarks/wiki:2`, `neosmemo/memos:stable`,
   `ghost:5-alpine`, `quay.io/hedgedoc/hedgedoc:1.10.8`.
2. **A major-version tag**, where upstream publishes one but its own docs still say
   `:latest`.
3. **`:latest`**, only where upstream publishes no narrower stable tag. Say so on the
   line:
   `image: example/app:latest  # upstream publishes no versioned tag`

**Always write a tag.** A bare `image: example/app` silently means `:latest` and hides
the choice from review.

Prefer an image published by the upstream project itself — its own `ghcr.io`,
`docker.io` or `quay.io` namespace, or a Docker Official Image — over a third-party
rebuild. Where only a third-party image exists (`ghcr.io/muchobien/pocketbase`,
`lscr.io/linuxserver/*`), that is fine; note the publisher in `metadata.yaml`.

**Do not pin by `@sha256` digest.** A digest freezes an app at the moment its entry
landed, and this catalog has no mechanism to re-pin. Bumping an image is not a one-line
edit: `metadata.yaml` records `images[].size_mb` and `test_results.last_tested`, so a
bump means re-running the app locally and re-measuring. A digest nobody refreshes is a
permanently unpatched image — worse than following upstream.

## Updating an Existing App

If an app's configuration changes (new env vars, different ports, etc.), update the Launchfile and note what changed in the PR description.

## Reporting Gaps

If the Launchfile format can't fully express an app's requirements, document the gap in your PR and we'll track it in [GAPS.md](GAPS.md).
