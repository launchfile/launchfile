# Launchfile Catalog

Community-maintained Launchfiles for popular open-source applications. Each Launchfile describes what an app needs to run — its components, services, environment, and health checks — so any Launchfile-compatible platform can deploy it.

Browse the catalog at [launchfile.io/apps](https://launchfile.io/apps/).

## Structure

```
apps/       Tested and verified — launches successfully
drafts/     Proposed — Launchfile written, not yet verified
```

Tested apps are listed at [launchfile.io](https://launchfile.io/apps/) with screenshots, test results, and one-command launch instructions. The source of truth for tested apps is the `apps/` directory itself — see the [live catalog](https://launchfile.io/apps/) rather than a static list here.

## Proposed Apps

These apps have draft Launchfiles in [`drafts/`](drafts/) but have not yet been verified end-to-end. PRs welcome to test and promote them to `apps/`.

| App                                                | Category      | Notes                               |
|----------------------------------------------------|---------------|-------------------------------------|
| [AnythingLLM](drafts/anythingllm/)                 | AI/ML         |                                     |
| [Appwrite](drafts/appwrite/)                       | Backend       | Gap: no mariadb type (G-3)          |
| [Calibre Web](drafts/calibre-web/)                 | Media         | Gap: host bind mount (G-12)         |
| [Changedetection](drafts/changedetection/)         | Monitoring    | Gap: shared volume (G-13)           |
| [Chatwoot](drafts/chatwoot/)                       | Communication |                                     |
| [Dashy](drafts/dashy/)                             | Dashboard     |                                     |
| [Dify](drafts/dify/)                               | AI/ML         | Gap: command override (G-17)        |
| [Diun](drafts/diun/)                               | Monitoring    | Gap: device passthrough (G-11)      |
| [Duplicati](drafts/duplicati/)                     | Backup        |                                     |
| [Fider](drafts/fider/)                             | Feedback      |                                     |
| [HedgeDoc](drafts/hedgedoc/)                       | Editor        |                                     |
| [Home Assistant](drafts/home-assistant/)           | Automation    | Gaps: G-9, G-11, G-12               |
| [Hoppscotch](drafts/hoppscotch/)                   | API Tools     |                                     |
| [Immich](drafts/immich/)                           | Photos        | Gap: GPU (G-10)                     |
| [Jellyfin](drafts/jellyfin/)                       | Media         | Gap: GPU (G-10), device (G-11)      |
| [LangFuse](drafts/langfuse/)                       | AI/ML         |                                     |
| [LibreChat](drafts/librechat/)                     | AI/ML         |                                     |
| [Mailpit](drafts/mailpit/)                         | Email         |                                     |
| [Mattermost](drafts/mattermost/)                   | Communication |                                     |
| [n8n](drafts/n8n/)                                 | Automation    |                                     |
| [Nextcloud](drafts/nextcloud/)                     | Files         | Gaps: G-13, G-17                    |
| [Ollama + Open WebUI](drafts/ollama-openwebui/)    | AI/ML         | Gap: GPU (G-10)                     |
| [Penpot](drafts/penpot/)                           | Design        |                                     |
| [Pi-hole](drafts/pihole/)                          | DNS           |                                     |
| [Plausible](drafts/plausible/)                     | Analytics     | Gap: no clickhouse type (G-4)       |
| [Plex](drafts/plex/)                               | Media         | Gap: GPU (G-10)                     |
| [PostHog](drafts/posthog/)                         | Analytics     |                                     |
| [Rocket.Chat](drafts/rocketchat/)                  | Communication | Gap: replica set (G-5)              |
| [Strapi](drafts/strapi/)                           | CMS           |                                     |
| [Supabase](drafts/supabase/)                       | Backend       |                                     |
| [Syncthing](drafts/syncthing/)                     | Sync          |                                     |

## Promoting a Draft

1. Test the draft: `cd test && bun run src/test-app.ts <app-name>`
2. If it passes, move it: `git mv catalog/drafts/<app> catalog/apps/<app>`
3. The test harness writes `metadata.yaml` with test results and a screenshot

## Contributing

To add a new app, create a directory in `drafts/` with a `Launchfile` and `metadata.yaml`. See any existing app for the format. Run the test harness to validate.

## Known Gaps

[GAPS.md](GAPS.md) documents spec limitations discovered by testing real apps. These inform future spec evolution.

## License

[MIT](../LICENSE)
