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
- `/learn/` — Step-by-step course: 3 modules, 8 numbered lessons (`src/pages/learn/`)
- `/quick-start` — Getting started guide
- `/installation` — Installation instructions
- `/writing-a-launchfile` — Authoring guide (thin overview; links to lessons and the spec)
- `/sdk` — SDK reference
- `/examples/[slug]` — Example Launchfiles

## The learn course

Lessons are plain `.astro` pages under `src/pages/learn/`, built from the shared components in `src/components/learn/` (CourseLayout, CodeBuildUp, BeforeAfter, Callout, GlossaryTip, Quiz, RealWorldExample). Real Launchfiles are imported at build time via `?raw` from `../spec/examples/` and `../catalog/apps/` — never inlined — so lessons track the spec automatically.

Adding a lesson is a **three-place update**:

1. `src/lib/navigation.ts` — the hand-numbered "Learn" NavGroup
2. `src/pages/learn/index.astro` — the module's `lessons` array + the hero lesson/minute counts
3. The previous lesson's `nextLesson` prop — the chain is a linked list; the final lesson carries the "Course complete!" card instead

Lessons cross-reference each other by number in prose ("Lesson 5 distinguished…") — grep `Lesson [0-9]` before renumbering anything.

## Design Principles

- Minimal, fast, text-focused — the spec sells itself
- No JavaScript required for the landing page
- Mobile-responsive from the start
- Links to GitHub for spec, SDK, and catalog (no duplication)
