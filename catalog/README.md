# Launchfile Catalog

Community-maintained Launchfiles for popular open-source applications. Each Launchfile describes what an app needs to run — its components, services, environment, and health checks — so any Launchfile-compatible platform can deploy it.

## What this catalog is

A community-maintained index of Launchfiles for third-party apps, with the `apps/`
entries verified to launch. It follows each upstream project's own release channel; it
is not a distribution and does not re-publish, freeze, or vouch for upstream images.
Platforms that deploy from this catalog own their own supply-chain controls — image
admission, scanning, pull-through caching. That boundary is deliberate: the risk
originates with the upstream publishers, and it is defended where the image is pulled
and run, not in the index that names it.

## Structure

```
apps/       Tested and verified — launches successfully
drafts/     Proposed — Launchfile written, not yet verified
```

Every entry is a directory holding a `Launchfile`. Entries the test harness has run also
hold a `metadata.yaml` with the results (`test/src/test-app.ts` writes it). Some also hold a
`screenshot.png`, captured separately with `test/src/screenshot-all.ts`. Screenshots are
optional. The directories are the source of truth: the two tables below are generated from
them by `catalog/test/src/build-index.ts`.

## Tested Apps

These apps have been verified to launch successfully from their Launchfile. The Gaps
column lists the open [GAPS.md](GAPS.md) entries that name the app.

<!-- BEGIN GENERATED: apps — edit the directories, then run `bun run build-index` in catalog/test -->
| App | Category | Description | Services | Gaps |
|-----|----------|-------------|----------|------|
| [activepieces](apps/activepieces/) | — | Workflow automation with 200+ integrations (open-source Zapier alternative) | postgres, redis | |
| [actual-budget](apps/actual-budget/) | Finance | Local-first personal budgeting app inspired by YNAB | — | |
| [answer](apps/answer/) | Forum | Q&A platform for community knowledge sharing (Apache project) | — | |
| [archivebox](apps/archivebox/) | Archiving | Self-hosted web archiving — saves HTML, JS, PDFs, media from any URL | — | |
| [audiobookshelf](apps/audiobookshelf/) | Media | Self-hosted audiobook and podcast server | — | |
| [beszel](apps/beszel/) | Monitoring | Lightweight server monitoring with Docker stats, historical data, and alerts | — | |
| [blinko](apps/blinko/) | Notes | AI-powered note tool for quickly capturing and organizing fleeting thoughts | postgres | |
| [bookstack](apps/bookstack/) | Wiki | Simple, self-hosted, easy-to-use wiki platform | mysql | |
| [cobalt](apps/cobalt/) | Media | Fast, no-nonsense media downloader for YouTube, Twitter, and more | — | |
| [cyberchef](apps/cyberchef/) | Development | Web app for data encoding, decoding, encryption, and analysis | — | |
| [dockge](apps/dockge/) | Docker Management | Easy-to-use Docker Compose stack manager with web UI | — | |
| [docmost](apps/docmost/) | Wiki | Collaborative wiki and documentation platform (Notion/Confluence alternative) | postgres, redis | |
| [etherpad](apps/etherpad/) | Collaboration | Real-time collaborative document editor | — | |
| [excalidraw](apps/excalidraw/) | Collaboration | Virtual whiteboard for sketching hand-drawn diagrams | — | |
| [file-browser](apps/file-browser/) | File Management | Web-based file manager for browsing and managing files | — | |
| [firefly-iii](apps/firefly-iii/) | Finance | Personal finance manager with budgeting and reporting | postgres | |
| [flowise](apps/flowise/) | AI/ML | Low-code LLM workflow builder | — | |
| [freshrss](apps/freshrss/) | RSS | Self-hosted RSS feed aggregator | — | |
| [gatus](apps/gatus/) | Monitoring | Developer-oriented health dashboard and status page with alerting | — | |
| [ghost](apps/ghost/) | CMS | Professional publishing platform | mysql | |
| [gitea](apps/gitea/) | Git | Lightweight self-hosted Git service | postgres | |
| [glance](apps/glance/) | Dashboard | Self-hosted dashboard with RSS, weather, bookmarks, and more | — | |
| [gokapi](apps/gokapi/) | File Sharing | Self-hosted file sharing with expiring download links | — | |
| [gotify](apps/gotify/) | Notifications | Self-hosted push notification server with REST API and web UI | — | |
| [grafana](apps/grafana/) | Monitoring | Observability and data visualization platform for metrics and logs | — | |
| [grocy](apps/grocy/) | Organization | Web-based groceries and household management for your home | — | |
| [hedgedoc](apps/hedgedoc/) | Documents | Collaborative markdown editor | postgres | G-1 |
| [homebox](apps/homebox/) | Organization | Open-source home inventory manager with barcode scanning and label generation | — | |
| [homepage-dashboard](apps/homepage-dashboard/) | Dashboard | Customizable application dashboard with service integrations | — | |
| [it-tools](apps/it-tools/) | Utilities | Handy online tools for developers | — | |
| [karakeep](apps/karakeep/) | Bookmarks | Bookmark-everything app with full-text search and AI tagging | — | |
| [kavita](apps/kavita/) | Media | Fast ebook and manga library supporting a wide array of file formats | — | |
| [linkding](apps/linkding/) | Bookmarks | Self-hosted bookmark manager | — | |
| [linkwarden](apps/linkwarden/) | — | Collaborative bookmark manager with full-text search and AI tagging | postgres | |
| [listmonk](apps/listmonk/) | Email | High-performance self-hosted newsletter and mailing list manager | postgres | |
| [mailpit](apps/mailpit/) | Development | Email testing tool with SMTP server and web UI (successor to MailHog) | — | |
| [matomo](apps/matomo/) | — | Privacy-focused web analytics platform (formerly Piwik, Google Analytics alternative) | mariadb | |
| [mealie](apps/mealie/) | Recipes | Self-hosted recipe manager and meal planner | — | |
| [memos](apps/memos/) | Notes | Lightweight self-hosted memo hub | — | |
| [metabase](apps/metabase/) | Analytics | Business intelligence and analytics tool | postgres | |
| [miniflux](apps/miniflux/) | RSS | Minimalist and opinionated feed reader | postgres | |
| [monica](apps/monica/) | CRM | Personal CRM for managing relationships and social interactions | mysql | |
| [navidrome](apps/navidrome/) | Music | Modern music server compatible with Subsonic | — | |
| [nocodb](apps/nocodb/) | Database | Open-source Airtable alternative — turns any database into a smart spreadsheet | — | |
| [node-red](apps/node-red/) | Automation | Low-code visual programming for event-driven automation | — | |
| [ntfy](apps/ntfy/) | Notifications | Simple HTTP-based pub-sub push notification service | — | |
| [openclaw](apps/openclaw/) | AI/ML | Open-source AI tools platform | — | G-19 |
| [opengist](apps/opengist/) | Development | Self-hosted pastebin and code snippet manager powered by Git | — | |
| [outline](apps/outline/) | Wiki | Modern team knowledge base for collaborative documentation | postgres, redis | |
| [paperclip](apps/paperclip/) | AI/Automation | Open-source orchestration for zero-human companies | postgres | |
| [paperless](apps/paperless/) | Documents | Searchable archive for physical documents | postgres, redis | |
| [pocketbase](apps/pocketbase/) | Backend | Real-time backend in a single Go binary with embedded SQLite | — | |
| [privatebin](apps/privatebin/) | Pastebin | Minimalist zero-knowledge online pastebin | — | |
| [rallly](apps/rallly/) | — | Schedule group meetings without the back and forth (Doodle alternative) | postgres | |
| [redmine](apps/redmine/) | Projects | Flexible project management web application | postgres | |
| [remote-claude-concentrator](apps/remote-claude-concentrator/) | Utilities | Remote Claude session concentrator and dashboard | — | |
| [rsshub](apps/rsshub/) | RSS | Generate RSS feeds from almost any website | — | |
| [searxng](apps/searxng/) | Search | Privacy-respecting metasearch engine aggregating results from 70+ sources | — | |
| [snipe-it](apps/snipe-it/) | — | IT asset management for tracking hardware, software licenses, and accessories | mariadb | |
| [stirling-pdf](apps/stirling-pdf/) | Documents | Web-based PDF manipulation tool | — | |
| [sure](apps/sure/) | Finance | Financial planning and wealth management platform for personal finance overview | — | |
| [trilium-notes](apps/trilium-notes/) | Note-Taking | Hierarchical note-taking and personal knowledge base | — | |
| [umami](apps/umami/) | Analytics | Simple, fast, privacy-focused web analytics | postgres | |
| [uptime-kuma](apps/uptime-kuma/) | Monitoring | Self-hosted monitoring tool | — | |
| [vaultwarden](apps/vaultwarden/) | Passwords | Self-hosted password manager — works with all Bitwarden apps and browser extensions | — | |
| [wallabag](apps/wallabag/) | Bookmarks | Read-it-later app for saving web pages to read offline (Pocket alternative) | — | |
| [wallos](apps/wallos/) | Finance | Subscription and expense tracker with multi-currency support | — | |
| [web-check](apps/web-check/) | Security | All-in-one OSINT tool for analyzing any website | — | |
| [wikijs](apps/wikijs/) | Wiki | Powerful wiki engine with markdown support and Git sync | postgres | |
| [wordpress](apps/wordpress/) | CMS | Popular open-source content management system | mysql | |
| [zeroclaw](apps/zeroclaw/) | AI | Lightweight Rust-based AI personal assistant (OpenClaw family) | — | |
<!-- END GENERATED: apps -->

## Proposed Apps

Draft Launchfiles in [`drafts/`](drafts/) — not yet verified end-to-end. PRs welcome to test and promote them to `apps/`. The Gaps column lists the open [GAPS.md](GAPS.md) entries that name the app.

<!-- BEGIN GENERATED: drafts — edit the directories, then run `bun run build-index` in catalog/test -->
| App | Category | Description | Services | Gaps |
|-----|----------|-------------|----------|------|
| [adguard-home](drafts/adguard-home/) | — | Network-wide ad and tracker blocking DNS server | — | |
| [anythingllm](drafts/anythingllm/) | AI/ML | All-in-one RAG and AI chat application | — | |
| [appwrite](drafts/appwrite/) | Backend | Open-source backend platform for web and mobile apps | mariadb, redis | G-3 |
| [authelia](drafts/authelia/) | — | Authentication and authorization server with SSO and 2FA | redis | |
| [calcom](drafts/calcom/) | — | Scheduling infrastructure for everyone (open-source Calendly alternative) | postgres | |
| [calibre-web](drafts/calibre-web/) | Media | Web app for browsing and reading e-books | — | G-12 |
| [changedetection](drafts/changedetection/) | Monitoring | Web page change detection and monitoring | — | G-1, G-13 |
| [chatwoot](drafts/chatwoot/) | Communication | Open-source customer support platform | postgres, redis | |
| [checkmate](drafts/checkmate/) | — | Monitor uptime, response times, and server health with beautiful dashboards | mongodb | |
| [dashy](drafts/dashy/) | Dashboard | Self-hosted personal dashboard | — | |
| [dify](drafts/dify/) | AI/ML | AI application development platform | postgres, redis | G-1, G-17 |
| [discourse](drafts/discourse/) | — | Discussion platform built for the next decade of the Internet — forum, mailing list, and chat | postgres, redis | |
| [diun](drafts/diun/) | Monitoring | Docker image update notifier | — | G-11, G-12, G-18 |
| [duplicati](drafts/duplicati/) | Files | Free backup software with cloud storage support | — | |
| [fider](drafts/fider/) | Feedback | Open-source community feedback platform | postgres | |
| [hedgedoc-v2](drafts/hedgedoc-v2/) | Documents | Collaborative markdown editor | postgres | |
| [home-assistant](drafts/home-assistant/) | Automation | Open-source home automation platform | — | G-9, G-9b, G-11, G-12 |
| [hoppscotch](drafts/hoppscotch/) | Utilities | Open-source API development ecosystem | postgres | G-1 |
| [immich](drafts/immich/) | Photos | High-performance self-hosted photo management | postgres, redis | G-10 |
| [jellyfin](drafts/jellyfin/) | Media | Free media system for movies, TV, and music | — | G-10, G-11 |
| [keycloak](drafts/keycloak/) | — | Identity and access management with SSO, social login, and user federation | postgres | |
| [langfuse](drafts/langfuse/) | AI/ML | Open-source LLM observability and analytics | postgres | |
| [librechat](drafts/librechat/) | AI/ML | AI chat platform supporting multiple LLM providers | mongodb | |
| [mattermost](drafts/mattermost/) | Communication | Open-source team messaging and collaboration | postgres | |
| [n8n](drafts/n8n/) | Automation | Workflow automation tool | postgres | |
| [nextcloud](drafts/nextcloud/) | Files | Self-hosted file sync and collaboration platform | postgres, redis | G-13, G-17, G-18 |
| [nginx-proxy-manager](drafts/nginx-proxy-manager/) | — | Reverse proxy with SSL management and a clean web UI | — | |
| [ollama-openwebui](drafts/ollama-openwebui/) | AI/ML | LLM inference server with chat UI | — | G-1, G-10 |
| [penpot](drafts/penpot/) | Design | Open-source design and prototyping platform | postgres, redis | |
| [photoprism](drafts/photoprism/) | — | AI-powered photo management with face recognition and maps | mariadb | |
| [pihole](drafts/pihole/) | DNS | Network-wide ad blocking via DNS | — | |
| [plausible](drafts/plausible/) | Analytics | Privacy-friendly web analytics | clickhouse, postgres | |
| [plex](drafts/plex/) | Media | Media server for personal media streaming | — | G-10, G-14 |
| [portainer](drafts/portainer/) | — | Container management platform with web UI | — | |
| [posthog](drafts/posthog/) | — | Open-source product analytics, session replay, and feature flags | clickhouse, kafka, postgres, redis | |
| [reactive-resume](drafts/reactive-resume/) | — | Open-source resume builder with real-time preview and export | postgres | |
| [rocketchat](drafts/rocketchat/) | Communication | Open-source team communication platform | mongodb | G-5 |
| [strapi](drafts/strapi/) | CMS | Open-source headless CMS | postgres | |
| [supabase](drafts/supabase/) | Backend | Open-source Firebase alternative | — | |
| [syncthing](drafts/syncthing/) | Sync | Continuous peer-to-peer file synchronization | — | G-9 |
| [twenty](drafts/twenty/) | — | Modern open-source CRM platform for managing customer relationships | postgres, redis | |
| [wg-easy](drafts/wg-easy/) | — | WireGuard VPN server with simple web management UI | — | |
<!-- END GENERATED: drafts -->

## Promoting a Draft

1. Test the draft: `cd test && bun run src/test-app.ts <app-name>`
2. If it passes, move it: `git mv catalog/drafts/<app> catalog/apps/<app>`
3. The test harness writes `metadata.yaml` with test results. A screenshot is optional: `bun run src/screenshot-all.ts <app-name>` launches the app and saves `screenshot.png` to its directory. `test-app.ts` does not take screenshots.
4. Regenerate the tables above and commit the result:
   `cd test && bun run build-index`. The batch run (`src/test-all.ts`) derives its
   tiers from the directories, so it picks the app up without an edit.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to submit a Launchfile.

## Known Gaps

[GAPS.md](GAPS.md) documents spec limitations discovered by testing real apps. These inform future spec evolution.

## License

[MIT](../LICENSE)
