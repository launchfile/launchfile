# Launchfile Catalog

Community-maintained Launchfiles for popular open-source applications. Each Launchfile describes what an app needs to run — its components, services, environment, and health checks — so any Launchfile-compatible platform can deploy it.

## Structure

```
apps/       Tested and verified — launches successfully
drafts/     Proposed — Launchfile written, not yet verified
```

Tested apps have screenshots, test results, and metadata in their directory. The source of truth is the `apps/` directory itself.

## Tested Apps

These apps have been verified to launch successfully from their Launchfile:

| App | Category | Services |
|-----|----------|----------|
| [Audiobookshelf](apps/audiobookshelf/) | Media | — |
| [BookStack](apps/bookstack/) | Wiki | MySQL |
| [Flowise](apps/flowise/) | AI/ML | Postgres |
| [FreshRSS](apps/freshrss/) | RSS | Postgres |
| [Ghost](apps/ghost/) | CMS | MySQL |
| [Gitea](apps/gitea/) | Git | Postgres |
| [IT Tools](apps/it-tools/) | Utilities | — |
| [LinkDing](apps/linkding/) | Bookmarks | Postgres |
| [Mealie](apps/mealie/) | Recipes | Postgres |
| [Memos](apps/memos/) | Notes | — |
| [Metabase](apps/metabase/) | Analytics | Postgres |
| [Miniflux](apps/miniflux/) | RSS | Postgres |
| [Navidrome](apps/navidrome/) | Music | — |
| [OpenClaw](apps/openclaw/) | AI/ML | — |
| [Paperclip](apps/paperclip/) | AI/ML | Postgres, Redis |
| [Paperless](apps/paperless/) | Documents | Postgres, Redis |
| [PrivateBin](apps/privatebin/) | Pastebin | — |
| [Redmine](apps/redmine/) | Projects | Postgres |
| [Stirling PDF](apps/stirling-pdf/) | Documents | — |
| [Umami](apps/umami/) | Analytics | Postgres |
| [Uptime Kuma](apps/uptime-kuma/) | Monitoring | — |
| [Vaultwarden](apps/vaultwarden/) | Passwords | — |
| [WordPress](apps/wordpress/) | CMS | MySQL |

## Proposed Apps

Draft Launchfiles in [`drafts/`](drafts/) — not yet verified end-to-end. PRs welcome to test and promote them to `apps/`.

| App | Category | Notes |
|-----|----------|-------|
| [Actual Budget](drafts/actual-budget/) | Finance | |
| [AnythingLLM](drafts/anythingllm/) | AI/ML | |
| [Appwrite](drafts/appwrite/) | Backend | Gap: no mariadb type (G-3) |
| [Calibre Web](drafts/calibre-web/) | Media | Gap: host bind mount (G-12) |
| [Changedetection](drafts/changedetection/) | Monitoring | Gap: shared volume (G-13) |
| [Chatwoot](drafts/chatwoot/) | Communication | |
| [Dashy](drafts/dashy/) | Dashboard | |
| [Dify](drafts/dify/) | AI/ML | Gap: command override (G-17) |
| [Diun](drafts/diun/) | Monitoring | Gap: device passthrough (G-11) |
| [Docmost](drafts/docmost/) | Wiki | |
| [Duplicati](drafts/duplicati/) | Backup | |
| [Fider](drafts/fider/) | Feedback | |
| [Gatus](drafts/gatus/) | Monitoring | |
| [Glance](drafts/glance/) | Dashboard | |
| [Gokapi](drafts/gokapi/) | Files | |
| [Gotify](drafts/gotify/) | Notifications | |
| [HedgeDoc](drafts/hedgedoc/) | Editor | |
| [Home Assistant](drafts/home-assistant/) | Automation | Gaps: G-9, G-11, G-12 |
| [Hoppscotch](drafts/hoppscotch/) | API Tools | |
| [Immich](drafts/immich/) | Photos | Gap: GPU (G-10) |
| [Jellyfin](drafts/jellyfin/) | Media | Gap: GPU (G-10), device (G-11) |
| [LangFuse](drafts/langfuse/) | AI/ML | |
| [LibreChat](drafts/librechat/) | AI/ML | |
| [Listmonk](drafts/listmonk/) | Email | |
| [Mailpit](drafts/mailpit/) | Email | |
| [Mattermost](drafts/mattermost/) | Communication | |
| [n8n](drafts/n8n/) | Automation | |
| [Nextcloud](drafts/nextcloud/) | Files | Gaps: G-13, G-17 |
| [NocoDB](drafts/nocodb/) | Database | |
| [Ollama + Open WebUI](drafts/ollama-openwebui/) | AI/ML | Gap: GPU (G-10) |
| [Opengist](drafts/opengist/) | Git | |
| [Penpot](drafts/penpot/) | Design | |
| [Pi-hole](drafts/pihole/) | DNS | |
| [Plausible](drafts/plausible/) | Analytics | Gap: no clickhouse type (G-4) |
| [Plex](drafts/plex/) | Media | Gap: GPU (G-10) |
| [PostHog](drafts/posthog/) | Analytics | |
| [Rocket.Chat](drafts/rocketchat/) | Communication | Gap: replica set (G-5) |
| [Strapi](drafts/strapi/) | CMS | |
| [Supabase](drafts/supabase/) | Backend | |
| [Syncthing](drafts/syncthing/) | Sync | |
| [Wallos](drafts/wallos/) | Finance | |

## Promoting a Draft

1. Test the draft: `cd test && bun run src/test-app.ts <app-name>`
2. If it passes, move it: `git mv catalog/drafts/<app> catalog/apps/<app>`
3. The test harness writes `metadata.yaml` with test results and a screenshot

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to submit a Launchfile.

## Known Gaps

[GAPS.md](GAPS.md) documents spec limitations discovered by testing real apps. These inform future spec evolution.

## License

[MIT](../LICENSE)
