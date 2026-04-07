# Launchfile Spec — Working Context

> For project-wide context, see [../CLAUDE.md](../CLAUDE.md)

## What's Here

This directory contains the Launchfile specification — the authoritative definition of the format.

- `SPEC.md` — Full specification reference (field types, examples, expression syntax)
- `DESIGN.md` — Design principles, decisions, trade-offs, known limitations
- `CONTRIBUTING.md` — How to propose spec changes (RFC process)
- `schema/launchfile.schema.json` — JSON Schema for validation and editor autocompletion
- `examples/` — Pattern examples demonstrating key features

## Key Rules

- The file is called `Launchfile` (no extension). It contains YAML.
- `version: launch/v1` is the current version. It defaults when absent.
- The format evolves additively — new fields, never new syntax (P-13).
- A spec change is a **breaking change** if it changes the meaning of an existing field or rejects a previously valid Launchfile.
- Non-breaking additions (new optional fields) need a design decision entry in DESIGN.md explaining the rationale.

## JSON Schema

The schema `$id` is `https://launchfile.dev/schema/v1`. Editors use:

```yaml
# yaml-language-server: $schema=https://launchfile.dev/schema/v1
```
