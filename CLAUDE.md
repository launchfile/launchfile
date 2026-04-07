# Launchfile

An open specification for describing application deployment requirements.

## Monorepo Structure

This repo contains independently-splittable packages:

- `spec/` — The specification document, JSON Schema, design docs, examples
- `catalog/` — Community Launchfiles for popular open-source apps
- `sdk/` — TypeScript reference parser, validator, and serializer

Each directory has its own `CLAUDE.md` with directory-specific context (where applicable).

## Commit Conventions

This monorepo is designed for future splitting via `git subtree split`. To keep that clean:

- **One commit, one directory.** Every commit is scoped to exactly one top-level directory.
- **Prefix format:** `spec:`, `sdk:`, `catalog:`, or `chore:` (for root-level files).
- **Cross-cutting changes** become multiple commits (e.g., a spec change + SDK update = 2 commits).
- **Commit bodies** explain *why*, not just *what*.

## Key Naming

- The file is called `Launchfile` (no extension). It contains YAML.
- Simple, intuitive, self-describing — like Dockerfile, Makefile, Procfile.

## Commands

```bash
# SDK development
cd sdk && bun install && bun test
```
