# Jellyfin integration

Jellyfin is a first-class reference provider alongside Plex. It supplies the
library inventory that local archive files are compared against.

## Configuration

Credentials are owner-scoped and stored in `user_setting`, never in process
environment variables:

| Setting | Meaning |
| --- | --- |
| `jellyfinServerUrl` | Base server URL, HTTP or HTTPS, no embedded credentials |
| `jellyfinApiKey` | Jellyfin API key, write-only across the API |
| `jellyfinUserId` | Optional; the first available user is resolved when unset |
| `archiveProvider` | `plex` or `jellyfin` — selects the active reference provider |

Generate an API key in Jellyfin under **Dashboard → Advanced → API Keys**.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/jellyfin/config` | Configuration status without secrets |
| `PATCH` | `/api/jellyfin/config` | Update server URL, API key, or user |
| `POST` | `/api/jellyfin/test-connection` | Verify the configured server |
| `POST` | `/api/jellyfin/sync` | Start an inventory synchronization |
| `GET` | `/api/jellyfin/inventory` | Owner-scoped libraries and items |

The API key is never returned. `hasApiKey` reports only whether one is stored.

## Provider selection

`resolveArchiveProvider` decides which inventory the archive comparison reads:

1. A valid `archiveProvider` setting wins.
2. Otherwise, if the owner has Jellyfin items and no Plex items, Jellyfin is
   used — a Jellyfin-only operator should not have to change a setting first.
3. Otherwise Plex is used, preserving existing behaviour.

Every comparison result carries `provider` and `providerLabel`, so a match
sourced from Jellyfin renders as `JELLYFIN MATCH` rather than `PLEX MATCH`.
The response field is still named `plexMatch` for backward compatibility; its
name does not imply the source.

## Safety properties

These mirror the Plex sync-safety rules and are covered by tests:

- **Network egress is guarded.** `lib/network-target.ts` resolves the hostname,
  refuses link-local, multicast, and unspecified addresses, honours `offline`
  and `local_only` network modes, and dials the validated address while
  preserving the original `Host` header and TLS server name. This closes the
  DNS-rebinding gap between validation and connection.
- **Reconciliation follows a complete fetch.** Libraries are staged in full
  before SQLite is touched. A library that fails to fetch is marked incomplete,
  which skips pruning, so a partial fetch never deletes existing inventory. The
  failure is surfaced as a warning event.
- **Pagination follows the declared total.** `TotalRecordCount` is honoured
  rather than assuming the requested page size was applied.
- **Upserts resolve identity by unique key.** After `ON CONFLICT DO UPDATE`,
  the row id is read back by `(owner_id, item_key)` instead of trusting
  `lastInsertRowid`.
- **Credentials travel in a header.** The API key is sent in `Authorization`,
  not a query string, so it is not captured by intermediate access logs.

## Data model

`jellyfin_library`, `jellyfin_item`, `jellyfin_media`, and `jellyfin_part`
mirror the Plex tables and are owner-scoped. Jellyfin runtime ticks are
converted to milliseconds (`ticks / 10_000`) so durations compare directly with
Plex and local metadata.
