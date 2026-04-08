# Catalog Entry Schema

The catalog is a registry of Launchfiles for open-source apps. Each entry is a thin YAML manifest (`entry.yaml`) that either points to a Launchfile in the app's own repo (upstream) or sits alongside a community-contributed Launchfile.

## Two source types

### Upstream — the Launchfile lives in the app's repo

```yaml
# catalog/apps/audiobookshelf/entry.yaml
source: upstream
repo: https://github.com/advplyr/audiobookshelf
paths:
  - Launchfile

description: "Self-hosted audiobook and podcast server"
category: Media
tags: [audiobooks, podcasts, self-hosted]
```

The app maintainer owns the Launchfile. The catalog just points to it.

### Community — the Launchfile lives in this repo

```yaml
# catalog/apps/ghost/entry.yaml
source: community
maintainer: "@ziadsawalha"

description: "Professional publishing platform"
category: CMS
tags: [blog, publishing, newsletter]
```

When `source: community`, the Launchfile sits next to `entry.yaml` in the same directory.

## Monorepo support

For repos with multiple deployable apps, `paths` lists each Launchfile:

```yaml
# catalog/apps/supabase/entry.yaml
source: upstream
repo: https://github.com/supabase/supabase
paths:
  - apps/studio/Launchfile
  - apps/api/Launchfile
  - apps/realtime/Launchfile

description: "Open source Firebase alternative"
category: Backend
tags: [database, auth, storage, realtime]
```

## Schema

```typescript
interface CatalogEntry {
  // Where the Launchfile lives
  source: "upstream" | "community";

  // For upstream: where to find it
  repo?: string;                   // required when source: upstream
  ref?: string;                    // branch/tag/commit — defaults to default branch
  paths?: string[];                // defaults to ["Launchfile"]

  // For community: who maintains the local copy
  maintainer?: string;             // required when source: community

  // Discovery metadata (both types)
  description: string;
  category: string;
  tags?: string[];
  logo?: string;                   // URL to app icon/logo

  // Verification status
  verified?: boolean;              // has it been tested end-to-end?
  verified_at?: string;            // ISO date of last verification
  verified_ref?: string;           // the ref that was verified
}
```

## Directory structure

```
catalog/apps/
  audiobookshelf/
    entry.yaml              # source: upstream, points to their repo
  ghost/
    entry.yaml              # source: community
    Launchfile              # the actual file, maintained here
  supabase/
    entry.yaml              # source: upstream, multiple paths
```

## Graduation path

Community entries can graduate to upstream when the app maintainer adopts the Launchfile into their own repo:

1. App maintainer adds a `Launchfile` to their repo
2. Catalog PR swaps `source: community` → `source: upstream`
3. Adds `repo` and `paths` fields
4. Deletes the local `Launchfile` copy

## CI validation

The catalog CI can fetch upstream Launchfiles via their pointers, validate them against the SDK schema, and flag breakage — keeping the registry trustworthy without owning the files.
