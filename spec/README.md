# Launchfile Specification

A **Launchfile** is a declarative app descriptor that tells a deployment platform everything it needs to clone, build, wire, and run an application. One file describes the runtime, network endpoints, resource dependencies, environment variables, lifecycle commands, and health checks.

```yaml
name: my-app
runtime: node
requires: [postgres]
commands:
  start: "node server.js"
health: /health
```

## Documents

| File | Description |
|------|-------------|
| [SPEC.md](SPEC.md) | Full specification reference |
| [DESIGN.md](DESIGN.md) | Design principles, decisions, and trade-offs |
| [schema/](schema/) | JSON Schema for editor autocompletion and validation |
| [examples/](examples/) | Pattern examples (minimal, multi-component, cron, etc.) |

## Using the JSON Schema

Add this comment to the top of your Launchfile for IDE autocompletion:

```yaml
# yaml-language-server: $schema=https://launchfile.dev/schema/v1
```

## License

[MIT](../LICENSE)
