# Usage intelligence direction

Accepted direction record. Written September 18, 2026.

This records the decision to treat **usage** as a first-class observational
layer alongside library and health, and fixes the boundaries that layer must
respect. It is a direction record, not a shipped-feature claim. Nothing in this
document is implemented: there is currently no watch, view, session, or usage
concept anywhere in the schema, services, or contract.

## Decision

Archive Assistant observes three things about the archive:

| Layer | Question | Current state |
| --- | --- | --- |
| Library | What exists? | Implemented — inventory, identity, metadata, providers, reconciliation |
| Health | Is it okay? | Implemented — integrity, duplicates, quality, storage, provider truth |
| Usage | What happens? | Not started |

Usage is accepted as the third layer. Arena remains above all three and owns
interpretation. Archive Assistant calculates and preserves facts; Arena reasons
over them. That split is unchanged and is the reason usage belongs here rather
than in the assistant.

## The boundary that matters most

Archive Assistant never plays media. It therefore **never directly observes a
watch**. Every watch record is a claim made by an external media server about
something that happened on a device Archive Assistant does not control.

So the model is not `watch_event` as ground truth. It is `watch_observation`,
carrying the same provenance discipline already applied to Plex inventory:
which provider asserted it, when it was collected, and which upstream record it
came from. This matches the existing memory boundaries — external systems are
replaceable providers, Archive Assistant is the source of truth for archive
identity and decisions, not for what a television did on a Tuesday.

Concretely, the proposed shape sits beside the existing provider observation,
not above it:

```
local_media_identity
  ├── file_record            (physical truth, owned)
  ├── plex_item              (provider observation)
  ├── archive_review         (decision truth, owned)
  └── watch_observation      (provider observation)  ← new
```

## Provider truth is lossy, and the design has to assume it

This is the part that will break the feature if it is discovered late. Upstream
watch history is not a reliable historical record:

- Plex exposes server-wide history at `/status/sessions/history/all`, but
  `viewCount` and `lastViewedAt` read through the owner token reflect the owner
  account rather than per-user state, and history rows survive for media that
  no longer exists in the library.[1][2]
- Plex's own dashboard keeps no analytics-grade history; Tautulli exists
  precisely to accumulate what the server does not retain.[3]
- Jellyfin logs no detailed playback history at all without the Playback
  Reporting plugin, and that plugin defaults to trimming data older than
  12 months via a scheduled `TaskCleanDb`.[4][5]
- History already trimmed upstream cannot be recovered by any later import.[6]

Three consequences that must be designed in from the first commit:

1. **Archive Assistant accumulates its own durable copy.** Ingestion is
   append-only and deduplicated on a stable observation identity. Once
   collected, an observation is not re-derived from the provider, because the
   provider may have deleted it.
2. **Observation windows are recorded explicitly.** The system must be able to
   distinguish "you watched nothing in March 2023" from "no provider was
   observed during March 2023." Without a coverage record, every trend
   statement is unfalsifiable. A gap is a fact and must be stored as one.
3. **Every metric carries a coverage denominator.** "1,173 untouched items" is
   only true if identity resolution between watch observations and
   `local_media_identity` is complete. If 40% of observations are unresolved,
   the honest output is a coverage-qualified figure, not a confident count.
   Unresolved observations are retained and surfaced, never dropped and never
   silently attributed to the nearest match.

## Derived metrics are recomputable, not remembered opinions

Sessions, aggregates, habits, and patterns are derivations. They follow the
pattern already used by `acquisition_recommendation`: persist the derivation
with an evidence hash over its inputs, so a changed input reopens the
derivation instead of leaving a stale number on a dashboard.

```
watch_observation      durable, append-only, provenance-bearing
        ↓               (sessionisation rules, versioned)
session                derived, recomputable
        ↓               (aggregation window)
usage_aggregate        derived, evidence-hashed
        ↓
Arena                  interpretation
```

The provenance chain the proposal asks for — "that statement should have
provenance" — is satisfied by making every displayed number resolvable back to
the observations that produced it, plus the coverage window it was computed
over. A claim like "viewing increased 31%" is only emitted when both comparison
windows have known coverage.

## What usage must never do

Usage intelligence is advisory and stays outside the mutation path. The
control-plane approval boundary is unchanged: a recommendation does not mutate
a file, approval alone does not mutate a file, and execution requires
confirmation.

The specific risk here is "dead storage." A never-watched signal is an
attractive input to deletion, and it is exactly the kind of signal that is
wrong when identity resolution is incomplete or when a provider was offline for
a year. Usage may contribute evidence to a recommendation. It must never
shorten the path from observation to deletion, and a usage-derived finding must
carry its coverage qualification into the review record.

Watch history is also the most personally sensitive data the product will ever
hold — more so than file paths. It is local-first by default, excluded from
logs, and given an explicit retention class in the same way `system_event`
already distinguishes operational from security retention. Hosted mode
inherits owner isolation, and device/client identifiers are treated as
sensitive rather than as ordinary metadata.

## Sequencing

The four analytics surfaces (LIBRARY, VIEWING, HABITS, EVOLUTION) are the right
end state and the wrong build order. Proposed order:

1. **Ingestion and provenance.** Observation model, stable identity, coverage
   windows, provider adapters behind the existing capability registry, honest
   disconnected states. No dashboard.
2. **Identity resolution.** Join observations to `local_media_identity` through
   existing reconciliation; publish the coverage figure as a first-class,
   visible number before any metric depends on it.
3. **Sessions and aggregates.** Versioned sessionisation, evidence-hashed
   aggregates, recomputable.
4. **Surfaces.** Viewing, then habits. Library already exists.

**One thing should start earlier than its surface.** EVOLUTION cannot be
backfilled. Library state at 2024-01-01 is unrecoverable if nobody wrote it
down. Periodic library-state snapshots — counts, size, identity coverage,
health totals — are cheap, independent of the usage layer, and only ever get
more valuable. If any part of this direction is started now, it should be that.

## A caveat on differentiation

The claim that the usage layer may be more differentiated than archive
management is half right, and the half that is wrong matters for scope.

Consumption analytics is an occupied field. Tautulli, Jellystat, and Playback
Reporting already produce hours-watched, per-user history, and completion
data.[3][6] Rebuilding those charts is not differentiation.

What none of them can do is join usage against archive truth, because none of
them model files, quality, integrity, storage, or acquisition. The questions
that are structurally unavailable to them are the ones worth building:

- Which terabytes are dead storage — never watched, and also large?
- Which acquisitions entered viewing life, and which never did?
- Do high-rewatch titles sit at the worst quality in the archive?
- Does an integrity finding correlate with abandonment, i.e. did the file fail
  rather than the film?
- Is acquisition rate outpacing consumption rate, in bytes as well as titles?

That join — usage against inventory, quality, integrity, and acquisition — is
the defensible surface. Not the hours-watched bar chart.

## Open questions

- Is usage single-owner by definition, or does a household imply per-viewer
  attribution? This changes the schema and cannot be retrofitted cheaply.
- Does a Plex "marked watched" with no history row count as usage? It is a
  library-state claim, not an observed session, and probably belongs in a
  different evidence class.
- What is the minimum play duration that constitutes a watch, and is that a
  stored rule or a recompute-time parameter? Tautulli treats it as
  configurable; making it recompute-time keeps old observations honest.
- Does importing an existing Tautulli or Playback Reporting archive count as an
  observation with provenance "imported", and how is a manual import's coverage
  window established?

## References

1. Plex Media Server API, status and playback history endpoints —
   https://developer.plex.tv/pms/
2. Per-user watch state through owner tokens, observed `viewedLeafCount`
   divergence — https://github.com/Maintainerr/Maintainerr/issues/3479
3. Plex retains no historical analytics; Tautulli fills that gap —
   https://oneuptime.com/blog/post/2026-02-08-how-to-run-tautulli-in-docker-for-plex-monitoring/view
4. Jellyfin logs no detailed playback history without Playback Reporting —
   https://jellywatch.app/blog/jellyfin-viewing-statistics-history-android-2026
5. Playback Reporting `MaxDataAge` defaults to 12 months, trimmed by
   `TaskCleanDb` —
   https://deepwiki.com/jellyfin/jellyfin-plugin-playbackreporting/4.1-scheduled-tasks
6. Trimmed upstream history cannot be imported later —
   https://docs.tracearr.com/getting-started/import
