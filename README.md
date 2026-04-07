# Launchfile

Describe your app. Deploy it anywhere.

A **Launchfile** is a simple YAML file that declares what your application is and what it needs to run — its components, services, environment, and health checks. Platform-agnostic, human-writable, machine-parseable.

```yaml
name: my-app
runtime: node
build: .
requires:
  - postgres
  - redis
env:
  PORT: "3000"
health: /healthz
```

## Why Launchfile?

|                          | Dockerfile    | docker-compose.yml    | Procfile   | Launchfile                    |
|--------------------------|---------------|-----------------------|------------|-------------------------------|
| Declares services needed | No            | Yes (you define them) | No         | Yes (you declare them)        |
| Platform-agnostic        | No (Docker)   | No (Docker)           | Heroku-ish | Yes                           |
| Multi-component          | No            | Yes                   | Flat       | Yes                           |
| Environment wiring       | No            | Manual                | No         | Automatic (`$` expressions)   |
| Human-writable           | Medium        | Verbose               | Simple     | Simple                        |

Existing tools describe **how** to build infrastructure. A Launchfile describes **what** an app needs — and lets the platform figure out the how.

## What's in this repo

| Directory    | Description                                                    |
|--------------|----------------------------------------------------------------|
| [`spec/`]     | The Launchfile specification, design docs, and JSON Schema     |
| [`catalog/`]  | Launchfiles for popular open-source apps                       |
| [`sdk/`]      | TypeScript reference implementation (parser, validator, serializer) |
| [`providers/`] | Platform providers that turn Launchfiles into running apps         |
| [`brand/`]     | Logos, colors, and design assets                                  |
| [`www-org/`]   | [launchfile.org](https://launchfile.org) — The specification      |

[`spec/`]: spec/
[`catalog/`]: catalog/
[`sdk/`]: sdk/
[`providers/`]: providers/
[`brand/`]: brand/
[`www-org/`]: www-org/

## Repository Structure

This is a monorepo containing the specification, reference SDK, and catalog. Components will be split into separate repositories as they develop independent contributor bases or release cadences.

## License

[MIT](LICENSE)
