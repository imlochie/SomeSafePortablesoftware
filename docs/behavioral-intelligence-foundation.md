# Behavioural Intelligence foundation

Behavioural signals are derived facts, not recommendations and not a universal taste score. Archive Assistant rebuilds them from canonical `watch_event` rows and preserves `watch_session`, scope identity, coverage, and event provenance.

Implemented signal surfaces:

- `long_term`: total watches, first/last activity, active months
- `recent`: 30/90-day activity windows
- `rewatch_affinity`: first watch, repeat count, and rewatch intervals
- `collection`: observed ownership relationship counts

Explicit operator statements are stored separately in `explicit_preference`; they are never silently merged with observed behaviour. Every signal carries a stable signal handle, `scopeIdentity`, coverage, `epistemicStatus`, provider-event handles, and ingestion-batch handles where the source observation has them. The provenance chain is therefore traceable from signal to `watch_event` to `watch_ingestion_batch` without exposing raw provider responses.

The read-only Arena boundary exposes these through `/api/assistant/personalisation-context` and adds them to `/api/assistant/archive-context`. It explicitly states that signals are observations, not likes or preferences, and that no recommendation decision is made by this layer.

Duration is classified separately from the signal itself: `provider_reported`, `observed_playback`, `derived`, `estimated`, or `unknown`. Plex history duration is provider-reported media duration and does not establish time actually watched. Unknown duration remains unknown; completion is not an observed primitive.

Signal rebuilds delete and recreate only derived rows. Raw events remain canonical. No weights, embeddings, recommendation lists, or taste score are introduced.
