# www-shared

Shared layouts, components, styles, and markdown plugins used by both `www-dev` (launchfile.dev) and `www-org` (launchfile.org).

## Markdown plugins (`lib/markdown/`)

Shared Sätteri (Astro 7 native markdown) plugins, wired into each site's
`astro.config.ts` `markdown.processor`:

- `hast-github-breaks.ts` — soft line breaks → `<br>` (matches GitHub's rendering of repo `.md` files; the `remark-breaks` replacement)
- `mdast-mermaid.ts` — ` ```mermaid ` fences → `<pre class="mermaid">` for client-side diagram rendering
- `mdast-rewrite-links.ts` — `createRewriteLinksPlugin(map)` factory; each site passes its own relative-link → route map

**This directory is a package** (has its own `package.json` + lockfile) because
those plugins import `satteri` / `hast` / `mdast` — which a raw source dir can't
resolve. **Run `bun install` here** (and CI does `cd www-shared && bun install
--frozen-lockfile`) before building a site, or the site config fails to resolve
`satteri`. The site `astro.config.ts` imports the plugins by relative path
(`../www-shared/lib/markdown/index.ts`), not the `@shared` alias, since the
config loader resolves before tsconfig path aliases apply.

## Responsive Header Behavior

Primary breakpoint at **1024px**, secondary at **768px**. Full logo always visible for brand recognition.

| Element     | ≥1024           | 768–1024        | <768                  |
|-------------|-----------------|-----------------|------------------------|
| Logo        | Full lockup     | Full lockup     | Full lockup            |
| Hamburger   | Hidden          | Visible         | Visible                |
| Search      | Input bar + ⌘K  | Input bar + ⌘K  | Magnifying glass icon  |
| Site tabs   | In header       | In drawer       | In drawer              |
| Sidebar     | On page         | In drawer       | In drawer              |
| GitHub icon | In header       | In header       | In header              |

### Drawer content order
1. **Site tabs** (Docs, Spec, Catalog, GitHub) as pill-style links
2. **Divider** (only when sidebar nav exists)
3. **Sidebar nav** (from `drawer-nav` slot, on docs pages)

### Key components
- `components/DocsHeader.astro` — Header + hamburger + drawer (shared by both sites)
- `components/SidebarNav.astro` — Sidebar navigation (slotted into drawer as `drawer-nav`)
- `components/Sidebar.astro` — Desktop sidebar wrapper

### CSS architecture
Both sites import shared base styles from `www-shared/styles/global.css`. Each site's `global.css` extends the shared base — `www-org` adds additional prose styling for rendered markdown spec pages.
