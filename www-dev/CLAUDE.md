# Launchfile Website — Working Context

> For project-wide context, see [../CLAUDE.md](../CLAUDE.md)

## What's Here

The launchfile.dev website. A simple, fast docs site built with Astro and deployed to Cloudflare Pages.

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

- `/` — Landing page (hero, comparison table, get started links)
- Future: `/spec` — rendered SPEC.md, `/catalog` — searchable app list

## Design Principles

- Minimal, fast, text-focused — the spec sells itself
- No JavaScript required for the landing page
- Mobile-responsive from the start
- Links to GitHub for spec, SDK, and catalog (no duplication)
