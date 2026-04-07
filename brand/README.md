# Launchfile Brand

Design assets and brand guidelines for the Launchfile project.

## Brand Attributes

- **Precise** — engineering-grade, not casual
- **Confident** — modern SaaS quality, not scrappy
- **Engineered** — infrastructure product, not consumer app
- **Actionable** — the file *does* something (deploys, launches)
- **Infrastructure** — ops angle, scaling, not just a config file
- **Open standard** — should feel inevitable, like it should have always existed

## Color Palette

Purple differentiates from the sea of blue DevOps tools (Docker, K8s, Terraform, GitHub Actions) while connecting to the CogZero brand family.

### Primary — Purple Ramp

| Stop | Hex | Usage |
|------|-----|-------|
| 900 | `#26215C` | Darkest text, deep backgrounds |
| 800 | `#3C3489` | Primary icon background |
| 600 | `#534AB7` | Grid lines, secondary marks |
| 400 | `#7F77DD` | Glow effects, mid-tone |
| 200 | `#AFA9EC` | Light accents |
| 100 | `#CECBF6` | Borders on light variant |
| 50 | `#EEEDFE` | Light mode background |

### Neutrals

| Name | Hex | Usage |
|------|-----|-------|
| ink | `#111111` | Body text, dark UI |
| charcoal | `#2C2C2A` | Secondary text |
| slate | `#444441` | Muted text, labels |
| paper | `#F5F4F0` | Alt backgrounds |
| white | `#FAFAF8` | Primary backgrounds |

See `colors/palette.css` for CSS custom properties.

## Typography

| Context | Style | Weight | Notes |
|---------|-------|--------|-------|
| Wordmark | Sans-serif | Medium | Slight negative tracking — `Launchfile` |
| Code context | Monospace | Regular | `Launchfile` |
| Label/micro | Sans-serif uppercase | Medium | Tracked — `LAUNCHFILE` |

Recommended fonts: **Inter**, **Geist**, or **Space Grotesk**.

## Logo

### Concept

Arrow emerging from a file/envelope — deployment in motion.

The mark consists of:
- A **rounded square** container (squircle, works as app icon / favicon)
- A **file/envelope shape** in the lower portion (low opacity, supporting role)
- An **upward arrow** as the hero element (deployment, launch, forward momentum)
- **Architectural grid lines** in the background (engineering precision, infrastructure)

### Construction

The logo uses layered translucency for depth (inspired by Untitled UI's multi-layer approach):

1. **Container** — Rounded square (`border-radius: ~25%`), clipped
2. **Grid layer** — Fine architectural grid (horizontal, vertical, concentric circles, diagonal crosshairs) in purple-600 at low opacity
3. **Central element** — Upward arrow with gradient fills, glow, and multi-overlay treatment for dimensionality
4. **File/envelope surface** — Translucent card in the lower portion, behind frosted glass
5. **Frosted glass panel** — `backdrop-filter: blur()` covering the lower portion; grid shows through blurred, arrow emerges from/through it
6. **Border and shadows** — Hairline border, multi-layer box shadows, inset shadow on glass edge

This must be built in **HTML/CSS** (not pure SVG) due to `backdrop-filter: blur()`.

### Variants

| Variant | Background | Arrow | Use |
|---------|-----------|-------|-----|
| Primary | `#3C3489` (purple-800) | White | Default, dark contexts |
| Light | `#EEEDFE` (purple-50) | `#534AB7` (purple-600) | Light contexts |
| Dark | `#111111` (ink) | White | Ink/dark mode |
| Monochrome | White | Black | Print |
| White | Transparent | White | Photo/video overlay |

### Sizes

| Size | Context | Notes |
|------|---------|-------|
| 200px | Hero / marketing | Full detail |
| 80px | App icon | Full detail |
| 48px | Navigation | Grid lines visible |
| 28px | Small UI | Simplified |
| 16px | Favicon | Arrow silhouette only, no grid |

### Source Files (SVG — no shadow, use CSS drop-shadow)

| File | What | Use at |
|------|------|--------|
| `mark.svg` | Full detail mark — **THE DEFAULT** | 48px and up |
| `mark-simple.svg` | Simplified (fewer grid lines) | 28–48px |
| `mark-light.svg` | Light variant (pale bg, purple arrow) | On colored/purple backgrounds |
| `mark-dark.svg` | Dark variant (ink bg, white arrow) | Dark mode |
| `favicon.svg` | Arrow silhouette on solid purple | 16px, browser tab |

### Raster Exports (PNG/ICO)

```
logo/exports/
├── github-avatar.png          # 500×500 — GitHub org/user avatar
├── mark-512.png               # 512×512
├── mark-256.png               # 256×256
├── mark-128.png               # 128×128
├── mark-64.png                # 64×64
├── mark-48.png                # 48×48 (from mark-simple.svg)
├── mark-32.png                # 32×32 (from mark-simple.svg)
├── mark-light-512.png         # 512×512 light variant
├── mark-light-128.png         # 128×128 light variant
├── mark-dark-512.png          # 512×512 dark variant
├── mark-dark-128.png          # 128×128 dark variant
├── apple-touch-icon.png       # 180×180 — iOS home screen
├── android-chrome-192.png     # 192×192 — Android
├── android-chrome-512.png     # 512×512 — Android splash
├── mstile-150x150.png         # 150×150 — Windows tiles
├── favicon.ico                # Multi-size ICO (16+32+48)
├── favicon-16.png             # 16×16 (from favicon.svg)
├── favicon-32.png             # 32×32 (from favicon.svg)
└── favicon-48.png             # 48×48 (from favicon.svg)
```

## Lockup Formats

| Format | Contents |
|--------|----------|
| **Horizontal** | Icon + "Launchfile" wordmark |
| **Dark bar** | Icon + "Launchfile" + "the deployment standard" tagline |
| **Badge** | `Launchfile ready` / `Launchfile v1` for README shields |
| **Compact** | Icon only (favicons, app icons) |

## Usage Rules

- Grid lines only appear at 48px and above
- At 16px, simplify to just the arrow silhouette on purple
- Minimum clear space: 1x icon height on all sides
- Arrow is always the hero — white on dark bg, purple-600 on light bg
- Envelope/file shape is always supporting (low opacity)
- Do not stretch, rotate, or recolor the logo outside defined variants

## Social Cards

```
social/
├── og-default.png    # 1200x630, default Open Graph image
├── og-spec.png       # For spec pages
└── og-catalog.png    # For catalog pages
```

## License

All brand assets are [MIT](../LICENSE) licensed.
