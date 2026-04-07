# www-shared

Shared layouts, components, and styles used by both `www-dev` (launchfile.dev) and `www-org` (launchfile.org).

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
