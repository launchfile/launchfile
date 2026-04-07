# Launchfile Catalog

Community-maintained Launchfiles for popular open-source applications. Each Launchfile describes what an app needs to run — its components, services, environment, and health checks — so any Launchfile-compatible platform can deploy it.

## Tested Apps

These apps have been verified to launch successfully from their Launchfile:

| App | Category | Services | Components |
|-----|----------|----------|------------|
| [Remote Claude Concentrator](apps/remote-claude-concentrator/) | AI/ML | — | 1 |

## Proposed Apps

The following apps have draft Launchfiles in [`drafts/`](drafts/) but have not yet been verified end-to-end. PRs welcome to test and promote them to `apps/`.

| App | Category | Services | Components | Notes |
|-----|----------|----------|------------|-------|
| [AnythingLLM](drafts/anythingllm/) | AI/ML | — | 1 | |
| [Appwrite](drafts/appwrite/) | Backend | MariaDB | Multi | Gap: no mariadb type (G-3) |
| [Audiobookshelf](drafts/audiobookshelf/) | Media | — | 1 | |
| [BookStack](drafts/bookstack/) | Wiki | MySQL | 1 | |
| [Calibre Web](drafts/calibre-web/) | Media | — | 1 | Gap: host bind mount (G-12) |
| [Changedetection](drafts/changedetection/) | Monitoring | — | 2 | Gap: shared volume (G-13) |
| [Chatwoot](drafts/chatwoot/) | Communication | Postgres, Redis | Multi | |
| [Dashy](drafts/dashy/) | Dashboard | — | 1 | |
| [Dify](drafts/dify/) | AI/ML | Postgres, Redis | Multi | Gap: command override (G-17) |
| [Diun](drafts/diun/) | Monitoring | — | 1 (cron) | Gap: device passthrough (G-11) |
| [Duplicati](drafts/duplicati/) | Backup | — | 1 | |
| [Flowise](drafts/flowise/) | AI/ML | Postgres | 1 | |
| [FreshRSS](drafts/freshrss/) | RSS | Postgres | 1 | |
| [Fider](drafts/fider/) | Feedback | Postgres | 1 | |
| [Ghost](drafts/ghost/) | CMS | MySQL | 1 | |
| [Gitea](drafts/gitea/) | Git | Postgres | 1 | |
| [HedgeDoc](drafts/hedgedoc/) | Editor | Postgres | 2 | |
| [Home Assistant](drafts/home-assistant/) | Automation | — | 1 | Gaps: G-9, G-11, G-12 |
| [Hoppscotch](drafts/hoppscotch/) | API Tools | Postgres | Multi | |
| [Immich](drafts/immich/) | Photos | Postgres, Redis | 2 | Gap: GPU (G-10) |
| [IT Tools](drafts/it-tools/) | Utilities | — | 1 | |
| [Jellyfin](drafts/jellyfin/) | Media | — | 1 | Gap: GPU (G-10), device (G-11) |
| [LangFuse](drafts/langfuse/) | AI/ML | Postgres | 1 | |
| [LibreChat](drafts/librechat/) | AI/ML | MongoDB | 1 | |
| [LinkDing](drafts/linkding/) | Bookmarks | Postgres | 1 | |
| [Mattermost](drafts/mattermost/) | Communication | Postgres | 1 | |
| [Mealie](drafts/mealie/) | Recipes | Postgres | 1 | |
| [Memos](drafts/memos/) | Notes | — | 1 | |
| [Metabase](drafts/metabase/) | Analytics | Postgres | 1 | |
| [Miniflux](drafts/miniflux/) | RSS | Postgres | 1 | |
| [n8n](drafts/n8n/) | Automation | Postgres, Redis | 1 | |
| [Navidrome](drafts/navidrome/) | Music | — | 1 | |
| [Nextcloud](drafts/nextcloud/) | Files | Postgres, Redis | 2 | Gaps: G-13, G-17 |
| [Ollama + Open WebUI](drafts/ollama-openwebui/) | AI/ML | — | 2 | Gap: GPU (G-10) |
| [OpenClaw](drafts/openclaw/) | — | Postgres | Multi | |
| [Paperless](drafts/paperless/) | Documents | Postgres, Redis | 1 | |
| [Penpot](drafts/penpot/) | Design | Postgres, Redis | Multi | |
| [Pi-hole](drafts/pihole/) | DNS | — | 1 | |
| [Plausible](drafts/plausible/) | Analytics | Postgres, ClickHouse | 1 | Gap: no clickhouse type (G-4) |
| [Plex](drafts/plex/) | Media | — | 1 | Gap: GPU (G-10) |
| [PrivateBin](drafts/privatebin/) | Pastebin | — | 1 | |
| [Redmine](drafts/redmine/) | Projects | Postgres, Redis | 1 | |
| [Rocket.Chat](drafts/rocketchat/) | Communication | MongoDB | 1 | Gap: replica set (G-5) |
| [Stirling PDF](drafts/stirling-pdf/) | Documents | — | 1 | |
| [Strapi](drafts/strapi/) | CMS | Postgres | 1 | |
| [Supabase](drafts/supabase/) | Backend | Postgres | 6 | |
| [Syncthing](drafts/syncthing/) | Sync | — | 1 | |
| [Umami](drafts/umami/) | Analytics | Postgres | 1 | |
| [Uptime Kuma](drafts/uptime-kuma/) | Monitoring | — | 1 | |
| [Vaultwarden](drafts/vaultwarden/) | Passwords | — | 1 | |
| [WordPress](drafts/wordpress/) | CMS | MySQL | 1 | |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to submit a Launchfile.

## Known Gaps

[GAPS.md](GAPS.md) documents spec limitations discovered by testing real apps against the Launchfile format. These inform future spec evolution.

## License

[MIT](../LICENSE)
