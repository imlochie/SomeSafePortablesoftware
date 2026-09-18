---
name: Archive provider attribution
description: Rule for keeping Plex/Jellyfin reference-inventory comparisons honest about their source.
---

Plex and Jellyfin are interchangeable reference providers. Exactly one is active per owner, resolved by `resolveArchiveProvider`, and every comparison result must carry the provider that produced it. Operator-facing summaries and UI labels must be derived from that value rather than hard-coded to Plex.

**Why:** The archive comparison originally assumed Plex, so a Jellyfin-sourced match still rendered as `PLEX MATCH` and quality summaries still said "Plex". Attribution that is inferred at the presentation layer drifts from the evidence that produced the finding.

**How to apply:** Read reference inventory through `readProviderRows`, keep `provider` on each comparison row, and build summaries with `providerLabel(provider)`. Treat an absent provider on older cached payloads as Plex so existing records keep a sensible label. The contract field remains `plexMatch` for compatibility; do not assume its name implies the source.

The provider preference falls back to whichever server actually has inventory when the `archiveProvider` setting is unset or unrecognized, so a Jellyfin-only operator gets comparisons without first changing a setting.
