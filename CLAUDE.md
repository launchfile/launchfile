# Launchfile

An open specification for describing application deployment requirements.

## Commit Conventions

This monorepo is designed for future splitting via `git subtree split`. To keep that clean:

- **One commit, one directory.** Every commit is scoped to exactly one top-level directory.
- **Prefix format:** `spec:`, `catalog:`, or `chore:` (for root-level files).
- **Cross-cutting changes** become multiple commits (e.g., a spec change + SDK update = 2 commits).
- **Commit bodies** explain *why*, not just *what*.

## Key Naming

- The file is called `Launchfile` (no extension). It contains YAML.
- Simple, intuitive, self-describing — like Dockerfile, Makefile, Procfile.
