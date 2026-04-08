# Releasing

How Launchfile packages are versioned, changelogged, and published.

## Overview

Releases are managed by [Changesets](https://github.com/changesets/changesets) and published via GitHub Actions using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC — no npm tokens stored).

### The Flow

```
Developer adds changeset → merges to main → bot opens "Version Packages" PR
                                            → merging that PR triggers npm publish
```

## Packages

Published in dependency order:

```
@launchfile/sdk          ← publish first
@launchfile/docker       ← depends on SDK
@launchfile/macos-dev    ← depends on SDK
launchfile               ← depends on SDK + docker
```

All packages use [linked versioning](https://github.com/changesets/changesets/blob/main/docs/linked-packages.md) — they share the same version number.

## Daily Workflow

### When your change affects users (new feature, bug fix, breaking change):

```bash
npx changeset add
```

The interactive prompt asks:
1. Which packages changed?
2. Bump type? (patch / minor / major)
3. Summary — write this in user-facing language

This creates a `.changeset/<random-name>.md` file. Commit it with your code.

**Example changeset file:**
```markdown
---
"@launchfile/sdk": patch
"launchfile": patch
---

Fixed expression resolver crash when input contains nested `${}` references.
```

### When your change is internal-only (CI, refactor, docs, tests):

Just commit normally. No changeset needed. No changelog entry will be generated.

### Writing good changeset summaries

- Write for users, not developers: "Added `--dry-run` flag" not "refactored CLI arg parsing"
- Start with a verb: Added, Fixed, Changed, Removed, Deprecated
- One sentence is fine for patches. A short paragraph for features.
- For breaking changes, explain what users need to do differently.

## Release Process

### Automated (normal path)

1. Changesets accumulate on `main` as PRs are merged
2. The [Changesets workflow](.github/workflows/changesets.yml) opens/updates a "Version Packages" PR
3. That PR shows: version bumps, changelog entries, consumed changeset files
4. **Merge the PR** → triggers the [Release workflow](.github/workflows/release.yml):
   - Tests run
   - Packages are published to npm with provenance
   - A GitHub Release is created with auto-generated notes

### Agent-driven release

An agent (Claude Code or similar) can execute the release:

1. Check if a "Version Packages" PR exists: `gh pr list --label "changesets"`
2. Review the PR diff (version bumps and changelog look correct)
3. Merge: `gh pr merge <number> --squash`
4. Verify publish: `npm view @launchfile/sdk version`

### Manual release (escape hatch)

If the automated flow breaks, publish from a local machine:

```bash
npx changeset version           # Consume changesets, bump versions, write changelog
git add -A
git commit -m "chore: version packages"
git push

# Wait for CI to pass, then publish manually:
cd sdk && npm publish --access public --provenance
cd providers/docker && npm publish --access public --provenance
cd providers/macos-dev && npm publish --access public --provenance
cd packages/launchfile && npm publish --access public --provenance

# Create the release:
VERSION=$(node -p "require('./sdk/package.json').version")
git tag "v${VERSION}" && git push origin "v${VERSION}"
gh release create "v${VERSION}" --generate-notes
```

## Workspaces

This monorepo uses Bun workspaces (defined in root `package.json`). Internal dependencies use caret ranges like `"@launchfile/sdk": "^0.1.4"` — Bun resolves these to the local workspace copy during development, and they publish to npm as-is.

**Why not `workspace:*`?** Neither `bun publish` nor `npm publish` reliably rewrites `workspace:*` to real version numbers. Use explicit `^x.y.z` ranges instead.

## Versioning Policy

- **Pre-1.0:** API is unstable. All packages share the same version.
- **Patch (0.1.x → 0.1.x+1):** Bug fixes, minor improvements. One-line changeset.
- **Minor (0.1.x → 0.2.0):** New features, non-breaking API additions.
- **Major / breaking:** Call out even pre-1.0. Explain migration in changeset summary.

## One-Time Setup

### 1. GitHub Environment

Create an environment called `npm-publish` in the repo settings:

1. Go to **Settings → Environments → New environment**
2. Name: `npm-publish`
3. No protection rules needed for now (add required reviewers later if desired)

The release workflow uses this environment for OIDC scoping.

### 2. npm Trusted Publishers

Each package must have a trusted publisher configured on npmjs.com:

1. Go to the package's access page on npmjs.com
2. Under **Trusted Publishers**, select **GitHub Actions**
3. Repository: `launchfile/launchfile`
4. Workflow: `release.yml`
5. Environment: `npm-publish`
6. Save

Packages:
- [@launchfile/sdk](https://www.npmjs.com/package/@launchfile/sdk/access)
- [@launchfile/docker](https://www.npmjs.com/package/@launchfile/docker/access)
- [@launchfile/macos-dev](https://www.npmjs.com/package/@launchfile/macos-dev/access)
- [launchfile](https://www.npmjs.com/package/launchfile/access)

### 3. npm Security Settings

Each package is configured with the strictest publishing security:

- **Require 2FA and disallow tokens** — no npm access tokens can publish these packages, only OIDC trusted publishing via GitHub Actions
- This means publishing is *only* possible through the release workflow in the `npm-publish` environment — not from a local machine, not with a leaked token, not without the GitHub OIDC handshake

To verify or change: go to each package's access page on npmjs.com → **Publishing access** section.

> **Note:** If you ever need the manual escape hatch (see above), you'd need to temporarily re-enable token-based publishing on npmjs.com, publish, then disable it again.
