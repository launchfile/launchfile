# Launchfile Specification Site — Working Context

> For project-wide context, see [../CLAUDE.md](../CLAUDE.md)

## What's Here

The launchfile.org website. The official specification site — renders the spec, design principles, and governance docs.

## Stack

- **Framework**: Astro (static output)
- **Styling**: Tailwind CSS v4 (via Vite plugin)
- **Hosting**: Cloudflare Pages
- **Colors**: Imported from `../brand/colors/palette.css`

## Commands

```bash
bun install        # Install dependencies
bun run dev        # Start dev server
bun run build      # Build for production
bun run preview    # Preview production build
```

## Pages

- `/` — Landing page
- `/spec/` — Rendered SPEC.md (the full specification)
- `/design` — Design principles (DESIGN.md)
- `/why` — Origin story (WHY.md)
- `/contributing` — How to contribute
- `/gaps` — Known limitations from catalog testing

## Design Principles

- Authoritative, minimal — the spec is the product
- Prose-optimized typography for long-form reading
- Shared header/footer/search with launchfile.dev via `www-shared/`
