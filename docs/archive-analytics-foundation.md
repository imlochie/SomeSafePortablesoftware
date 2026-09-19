# Archive Analytics foundation

## Canonical watch observation

`watch_event` is the current canonical `watch_observation` storage primitive. It means only:

> The provider reported a supported playback event that passed the owner, account, media-type, library, and event-type scope.

It is not evidence of liking, enjoyment, preference, completion, abandonment, bingeing, or a session. `watch_session`, ownership resolution, analytics, and behavioural signals remain derived layers above the observation. The table name remains `watch_event` to avoid broad schema churn; the semantic contract is canonical watch observation.

Each accepted observation preserves provider event identity, owner/provider scope, `scope_identity`, ingestion ID, coverage boundaries, observation time, and provenance. Ingestion rejects unsupported media, live/DVR events, ineligible accounts, out-of-scope libraries/scopes, and duplicate or incomplete provider identities. Historical coverage, collection start, and last successful ingestion remain separate.

Archive Assistant is the system of record for viewing observations. Plex history is translated at the provider boundary into `watch_event`; Plex fields do not escape the adapter. Raw events are retained, including events with no current archive match.

## Coverage

`historicalCoverageStart`, `collectingSince`, and `lastSuccessfulIngestion` are persisted independently. Historical facts (plays, unique titles, rewatches, calendar counts, ownership relationship) are not presented as session facts. Session-derived metrics remain `unknown` or `coverage-limited` until observation began.

## Read-only contract

- `GET /api/analytics` returns owner-scoped facts with `epistemicStatus` and provenance.
- `GET /api/assistant/archive-context` is the compact server-to-server Arena envelope.
- Arena has no provider, filesystem, credential, or mutation access.

`watch_event` is canonical. `watch_session` is rebuildable and is never used to replace events. Ownership is explicit: `currently_owned`, `previously_owned`, `departure_unconfirmed`, or `never_matched`.

The initial ingestion functions are intentionally adapter-facing (`normalizePlexHistory`, `ingestPlexHistory`, and `ingestWatchEvents`). `ingestPlexHistoryFromApi` now provides an API-first paginated backfill/incremental callable workflow. Each run records a durable `watch_ingestion_batch` with provider, scope, requested/covered window, status, completeness, page count, event count, and request context. Pages are validated before canonical ingestion; repeated pages/events remain safe through provider-event idempotency. A complete run advances successful coverage; a partial or failed run records its limitation without advancing successful coverage. An empty provider response is represented as `empty_authoritative`, distinct from failure. Scheduling remains a separate future operational concern.
