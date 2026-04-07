# Launchfile Brand — Working Context

> For project-wide context, see [../CLAUDE.md](../CLAUDE.md)

## What's Here

Canonical design assets and brand guidelines for the Launchfile project.

## Design Language

- **Precise, confident, engineered** — infrastructure product, not consumer app
- Purple palette (not blue — differentiates from Docker, K8s, Terraform)
- Layered translucency for depth (backdrop-filter, gradients, glow)
- Architectural grid lines convey engineering precision
- Sans-serif typography: Inter, Geist, or Space Grotesk

## Key Colors

| Role | Token | Hex |
|------|-------|-----|
| Primary bg | `--lf-purple-800` | `#3C3489` |
| Grid/secondary | `--lf-purple-600` | `#534AB7` |
| Glow | `--lf-purple-400` | `#7F77DD` |
| Light bg | `--lf-purple-50` | `#EEEDFE` |
| Text | `--lf-ink` | `#111111` |
| Paper | `--lf-paper` | `#F5F4F0` |

## Logo Construction

The logo is **HTML/CSS first** (not SVG) due to `backdrop-filter: blur()`:
1. Squircle container
2. Architectural grid at low opacity
3. Arrow hero with gradient + glow overlays
4. File/envelope shape (supporting, low opacity)
5. Frosted glass panel (lower half)
6. Hairline border + multi-layer shadows

Simplified SVG version (without blur) for contexts that need it.

## Size Rules

- 48px+: Full detail with grid lines
- 28px: Simplified, no grid
- 16px: Arrow silhouette only on solid purple
