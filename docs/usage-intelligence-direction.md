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

## What providers actually retain

Plex is a far stronger substrate than a cautious reading suggests, and the
design should exploit that rather than assume scarcity.

**Plex retains per-play history indefinitely.** Every play writes a row to
`metadata_item_views` in `com.plexapp.plugins.library.db`, and rows survive
deletion of the underlying media.[1] The server surfaces this as Play History
and Top Played on the Dashboard, filterable by media type and user.[2] Over the
API, `/status/sessions/history/all` is server-wide and filterable by
`accountID`, `librarySectionID`, `metadataItemID`, and `viewedAt>=`, which makes
incremental pulls straightforward.[3] Entries carry `accountID`, `deviceID`,
`viewedAt`, and `historyKey`.[4] Separately, `/statistics/media` returns
aggregated `count` and **`duration`** bucketed by `accountID`, `deviceID`,
`timespan`, and `metadataType`.[5]

So a years-deep history, per-account and per-device, is genuinely available and
backfillable on first connect. The earlier draft of this document claimed Plex
retained no analytics-grade history. That was wrong, and it was wrong in the
direction that would have under-scoped the feature.

**Jellyfin is the weak case, not Plex.** Native Jellyfin stores only current
state in `UserDatas` — `PlayCount`, `LastPlayedDate`, `PlaybackPositionTicks` —
with no per-play rows.[6][7] Per-play history requires the Playback Reporting
plugin, which defaults to trimming beyond 12 months via `TaskCleanDb`,[8][9]
and trimmed history cannot be recovered by later import.[10] The conclusions
below therefore apply unevenly, and the adapter must report *which* grade of
history a given provider is actually supplying.

### The distinction that actually matters

Not "retained vs. not retained." It is **event truth vs. session truth**:

| | Available how | Backfillable |
| --- | --- | --- |
| What, when, who, device | Per-play history rows | Yes, years deep |
| How long, completion, abandonment | Only live sessions, or pre-aggregated buckets | No |

A history row records *that* a play happened at a timestamp. It does not carry
that play's duration or stop position. Duration exists only in the aggregated
`/statistics/media` buckets — real, but detached from individual plays, and the
finer-grained buckets are pruned over time while coarser ones persist.[11] This
is precisely why Tautulli must run continuously and cannot retroactively import
history.[12]

The consequence for the proposal's metric list is sharp and worth stating
plainly, because it splits the feature in two:

- **Available from backfill, day one:** titles watched, plays per month,
  rewatch counts, time-of-day, weekday/weekend, time between episodes, binge
  runs, decades/genres/directors actually watched, first-watch vs. reacquisition
  dates, and the whole LIBRARY-vs-REALITY funnel.
- **Not backfillable, only accruing from the day collection starts:** average
  session length, completion rate, abandoned films, and "long-film completion
  68%."

Those second-category metrics are the ones the proposal leans on hardest for
the habits surface. They should be presented as accruing, with a visible
"collecting since" date, never computed from backfilled data as if equivalent.

### What still must be designed in

1. **Archive Assistant accumulates its own durable copy.** Even where Plex
   retains history, Archive Assistant should not depend on it remaining
   available: a server rebuild loses it unless the database was migrated,[13]
   and Jellyfin trims by default. Ingestion is append-only and deduplicated on a
   stable observation identity.
2. **Observation coverage is recorded explicitly.** Less critical for Plex
   backfill than the earlier draft assumed, but still required for the accruing
   metrics and for any provider whose history is trimmed or was installed late.
   A gap must be distinguishable from genuine inactivity.
3. **Every metric carries a coverage denominator.** "1,173 untouched items" is
   only true if identity resolution between watch observations and
   `local_media_identity` is complete. Unresolved observations are retained and
   surfaced, never dropped and never silently attributed to a nearest match.
   Note that history rows persist for deleted media, so a naive join produces
   watch events with no archive counterpart — that is a real and expected class,
   and arguably an interesting one ("what did I watch and then get rid of?").
4. **Played state and play history are different evidence.** Marking an item
   watched writes no history row,[14] and item-level `viewCount`/`lastViewedAt`
   read through the owner token report the owner rather than the viewing
   user.[15] Treat a manual mark as a library-state claim in a separate evidence
   class, not as an observed session.

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

Sessionisation deserves particular care, because it is where the event/session
gap gets bridged. Grouping history rows into sessions is inference, not
observation: consecutive episode rows minutes apart are *probably* one sitting.
That inference is legitimate and valuable, but it must be versioned, stored as
derived, and never presented with the same confidence as a directly observed
live session. Where both exist for the same period, observed duration wins over
inferred duration, and the aggregate should record which it used.

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

1. **Backfill ingestion.** Pull the full Plex history via
   `/status/sessions/history/all` with `viewedAt>=` paging, plus
   `/statistics/media` for duration buckets. Observation model, stable identity,
   provider adapters behind the existing capability registry, honest
   disconnected states, explicit history-grade reporting per provider. No
   dashboard. This alone yields years of data on first run.
2. **Identity resolution.** Join observations to `local_media_identity` through
   existing reconciliation; publish the coverage figure as a first-class,
   visible number before any metric depends on it. Expect and model the
   watched-but-no-longer-owned class.
3. **Live session capture.** Begin accruing the metrics backfill cannot supply —
   duration, completion, abandonment — from observed sessions going forward.
   Start this early precisely because it only accrues.
4. **Sessions and aggregates.** Versioned sessionisation over historical rows,
   evidence-hashed aggregates, recomputable, marked inferred vs. observed.
5. **Surfaces.** Viewing, then habits. Library already exists.

**Two things should start earlier than their surface**, because neither can be
backfilled:

- **Library-state snapshots.** EVOLUTION depends on them and they are
  unrecoverable retrospectively — library state at 2024-01-01 is gone unless
  something wrote it down. Counts, size, identity coverage, health totals.
  Cheap, independent of the usage layer, and only ever more valuable.
- **Live session capture** (step 3), for the same reason.

Everything else can wait, because Plex is holding it for you.

## A caveat on differentiation

The claim that the usage layer may be more differentiated than archive
management is half right, and the half that is wrong matters for scope.

Consumption analytics is an occupied field. Tautulli, Jellystat, and Playback
Reporting already produce hours-watched, per-user history, and completion data.
Rebuilding those charts is not differentiation.

There is, though, one genuine advantage available on day one: Tautulli cannot
retroactively import history and only knows what happened since it was
installed.[12] An archive-side backfill straight from `metadata_item_views`
starts with the *entire* history of the server. For an archive that predates
any monitoring tool, that is a real capability gap in Archive Assistant's
favour — and it is a one-time advantage, since Tautulli catches up from its own
install date onward.

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
  attribution? Plex history is per-`accountID`, so the data supports it and the
  choice is ours. This changes the schema and cannot be retrofitted cheaply.
- Read history over the API, or read `com.plexapp.plugins.library.db` directly?
  Direct reads are richer and faster for a large backfill, but reach into
  another application's private database and require its bundled SQLite build.
  The existing integration-adapter boundary points firmly at the API; this
  should be decided explicitly rather than by drift.
- Is a Plex play with no matching archive item — history rows persist after
  deletion — dead data, or its own interesting class ("watched, then removed")?
- What is the minimum play duration that constitutes a watch, and is that a
  stored rule or a recompute-time parameter? Making it recompute-time keeps old
  observations honest.
- Does importing an existing Tautulli or Playback Reporting archive count as an
  observation with provenance "imported", and how is a manual import's coverage
  window established? Tautulli in particular would be a strong secondary source
  for the session-duration data Plex history lacks.

## Revision note

The first version of this document claimed Plex retained no analytics-grade
history and that all usage data would have to accrue forward from installation.
That was incorrect: Plex keeps per-play rows indefinitely, including for deleted
media. The correction materially expands what is buildable — most of the
proposal's consumption and preference metrics are backfillable — and narrows the
real constraint to session-level duration and completion. Corrected
September 19, 2026.

## References

1. Play history is stored per-play in `metadata_item_views` and survives media
   deletion —
   https://www.reddit.com/r/PleX/comments/19avici/does_plex_save_watch_history/
2. Dashboard Play History and Top Played, filterable by media type and user
   (Plex Pass) — https://support.plex.tv/articles/200871837-status-and-dashboard/
3. `/status/sessions/history/all` with `accountID`, `librarySectionID`,
   `metadataItemID`, and `viewedAt` filters — https://developer.plex.tv/pms/
4. History entries expose `accountID`, `deviceID`, `viewedAt`, `historyKey` —
   https://python-plexapi.readthedocs.io/en/latest/modules/base.html
5. `/statistics/media` returns `count` and `duration` by account, device,
   timespan, and metadata type —
   https://plexapi.dev/api-reference/server/get-server-statistics
6. Jellyfin stores current state only, in `UserDatas` —
   https://github.com/jellyfin/jellyfin/discussions/8761
7. No per-title playback history natively; a plugin is required —
   https://www.reddit.com/r/jellyfin/comments/lh2b4n/how_to_view_play_counts/
8. Jellyfin logs no detailed playback history without Playback Reporting —
   https://jellywatch.app/blog/jellyfin-viewing-statistics-history-android-2026
9. Playback Reporting `MaxDataAge` defaults to 12 months, trimmed by
   `TaskCleanDb` —
   https://deepwiki.com/jellyfin/jellyfin-plugin-playbackreporting/4.1-scheduled-tasks
10. Trimmed upstream history cannot be imported later —
    https://docs.tracearr.com/getting-started/import
11. Finer-grained statistics buckets are pruned over time while coarser buckets
    persist —
    https://www.reddit.com/r/PleX/comments/ss1j9e/can_you_track_data_usage_per_user/
12. Tautulli must run continuously and cannot retroactively import history —
    https://docs.tautulli.com/support/frequently-asked-questions
13. Watch history lives in the server database and is lost on rebuild unless
    migrated —
    https://support.plex.tv/articles/201154527-move-viewstate-ratings-from-one-install-to-another/
14. A manual "mark watched" writes no history row —
    https://github.com/stevezau/shortlist/issues/108
15. Item-level `viewCount`/`lastViewedAt` via the owner token report the owner,
    not the viewing user —
    https://github.com/Maintainerr/Maintainerr/issues/3479
