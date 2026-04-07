# Releasing

How to publish new versions of Launchfile packages to npm.

## Packages

| Package | npm name | Published |
|---------|----------|-----------|
| `sdk/` | `@launchfile/sdk` | Yes |
| `providers/docker/` | `@launchfile/docker` | Not yet |
| `providers/macos-dev/` | `@launchfile/macos-dev` | Not yet |
| `packages/launchfile/` | `launchfile` | Yes (0.2.0) |

## Dependency Order

The SDK must be published before packages that depend on it:

```
@launchfile/sdk          ← publish first
@launchfile/docker       ← depends on SDK
@launchfile/macos-dev    ← depends on SDK
launchfile               ← depends on SDK + docker
```

## Workspaces

This monorepo uses Bun workspaces. Internal dependencies use `"workspace:*"` in `package.json`, which Bun resolves to local packages during development. When publishing, `bun publish` rewrites `workspace:*` to the actual version number automatically.

## Publishing Checklist

### 1. Make sure tests pass

```bash
cd sdk && bun test
cd providers/docker && bun test
cd providers/macos-dev && bun test
cd packages/launchfile && bun test
```

### 2. Bump versions

Update `version` in each package's `package.json`. All published packages should share the same version number to keep things simple.

```bash
# Example: bumping to 0.2.1
# Edit sdk/package.json, providers/docker/package.json, etc.
```

### 3. Update CHANGELOG.md

Add a new section at the top of `CHANGELOG.md` with the version and date.

### 4. Commit the version bump

One commit per directory (per monorepo convention):

```bash
# If SDK changed:
git add sdk/package.json && git commit -m "sdk: bump version to 0.2.1"

# If providers changed:
git add providers/docker/package.json && git commit -m "providers: bump docker version to 0.2.1"
git add providers/macos-dev/package.json && git commit -m "providers: bump macos-dev version to 0.2.1"

# If CLI changed:
git add packages/launchfile/package.json && git commit -m "packages: bump launchfile version to 0.2.1"

# Changelog is root-level:
git add CHANGELOG.md && git commit -m "chore: changelog for 0.2.1"
```

### 5. Tag and push

```bash
git tag v0.2.1
git push origin main --tags
```

### 6. Publish to npm (in dependency order)

```bash
cd sdk && bun publish --access public
cd providers/docker && bun publish --access public
cd providers/macos-dev && bun publish --access public
cd packages/launchfile && bun publish --access public
```

`bun publish` automatically rewrites `workspace:*` to real version numbers and builds if a `prepublishOnly` script exists.

### 7. Verify

```bash
npm view @launchfile/sdk version
npm view @launchfile/docker version
npm view launchfile version
npx launchfile --version
```

## Future Automation

When the release cadence justifies it, consider:
- GitHub Actions workflow triggered by version tags
- `changesets` for automated version management and changelogs
- `npm provenance` for supply chain attestation
