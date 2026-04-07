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
| [`spec/`]   | The Launchfile specification, design docs, and JSON Schema     |

[`spec/`]: spec/

## License

[MIT](LICENSE)
