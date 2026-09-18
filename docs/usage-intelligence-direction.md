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

### The provenance-window rule

Every metric declares the window its evidence actually covers, and the two
windows are never silently merged:

```
Historical metrics    play history, available since 2019
Session metrics       session tracking, since 19 September 2026
```

The failure this prevents is specific and would be easy to ship by accident:

> "Your average session length since 2019 is 47 minutes."

That number is unsupportable — the numerator comes from instrumentation that
began in 2026 while the denominator implies seven years. The honest form states
both windows and refuses the blend. The same rule kills silent extrapolation in
comparisons: a year-over-year change may only be computed where both windows
have comparable evidence grades, and a statement spanning the instrumentation
boundary must either be scoped to the instrumented period or be declined.

This is the reconciliation layer's existing epistemic discipline — evidence,
confidence, and honest `uncertain` — applied to behavioural analytics. Arena
can reason about a gap it is told about. It cannot detect one that has been
papered over.

### Ingestion path: API first, private database as a justified exception

The architectural default is API ingestion through the existing Plex adapter.
A direct read of `com.plexapp.plugins.library.db` is permitted only as a
deliberate, documented exception — justified by a concrete problem such as an
API backfill proving unworkable at 100k+ historical events, not by convenience.

If that exception is ever taken, it carries a hard contract:

```
private Plex database
        ↓   read-only, never written
   importer (sole owner of Plex's internal schema)
        ↓   normalised watch observations
   Archive Assistant truth model
```

No part of the application outside that importer may know Plex's internal
schema exists. No `metadata_item_views` column names in services, contracts,
or the UI. If Plex changes its schema, exactly one module breaks, and it fails
loudly rather than silently producing wrong history. The importer must also
treat the database as read-only and tolerate the file being locked by a running
server — Plex ships its own SQLite build for a reason, and writing to that file
from outside is out of scope permanently, not merely deferred.

This mirrors the existing integration-adapter boundary: external systems are
replaceable providers, and their internals never leak into the control plane.

### Scope validation is an ingestion contract, not a filter

Plex history is server-wide, so ingestion that takes it verbatim silently
imports things that are not the owner's archive behaviour. Scope is therefore a
mandatory validation stage, and the resulting dataset **carries its scope
definition as part of its identity**:

```
Plex history
    ↓
scope validation
    ├── account
    ├── media type
    ├── library
    ├── Live TV / DVR exclusion
    └── supported event types
    ↓
normalised watch observations  (scope definition attached)
```

What each rule excludes, and why it matters:

- **Account.** History carries `accountID`; a shared server records friends'
  and managed users' plays. Attribution is required before any "your viewing"
  claim is possible at all.
- **Live TV / DVR.** Playback with no durable archive item behind it. Not
  archive history, and left in it inflates every consumption metric.
- **Media type and library.** `metadataType` and `librarySectionID` span music
  and photos; the archive concern is movies and episodes unless deliberately
  widened.
- **Supported event types.** A manual "mark watched" writes no history row and
  is a library-state claim, not an observed play.

Every one of these is filterable from fields the history endpoint already
returns, so the cost is trivial. The discipline is not.

A metric computed over an unstated scope is irreproducible, and the failure
surfaces late and unanswerably. Six months on, Arena reports:

> "You've watched 2,481 things."

and nobody can answer **2,481 what?** — which accounts, which libraries,
including Live TV or not, movies only or episodes too, over which window. An
aggregate without its scope definition is a number without units. Persisting
the scope alongside the aggregate makes the question answerable by
construction, and makes a scope change visible as a recomputation rather than
as an unexplained discontinuity in a chart.

## What still must be designed in

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
   watch events with no archive counterpart. That is expected, and it resolves
   into the ownership relation below rather than into a single bucket — the
   absence of a counterpart alone does not establish that anything departed.
4. **Played state and play history are different evidence.** Marking an item
   watched writes no history row,[14] and item-level `viewCount`/`lastViewedAt`
   read through the owner token report the owner rather than the viewing
   user.[15] Treat a manual mark as a library-state claim in a separate evidence
   class, not as an observed session.

## Archive history: the ownership relation is first-class

History outliving deletion is not an awkward edge case to filter out. It is a
relation the media servers do not model as an archive concept, because they
have no concept of an archive that persists across deletion. Archive Assistant
does.

Every resolved watch observation therefore carries an **ownership relation**,
derived and recomputable rather than stored as a flag. There are four states,
not three:

```
WATCH OBSERVATION
        │
        ├── currently_owned         → item present in file_record / identity
        ├── previously_owned        → evidence it was owned AND evidence of departure
        ├── departure_unconfirmed   → evidence it was owned, departure unestablished
        └── never_matched           → no evidence it was ever owned
```

The fourth state is load-bearing. Without it, an item whose file has been
`missing` for a year has nowhere honest to go: calling it `currently_owned` is
false, and calling it `previously_owned` asserts a departure nobody observed.
`departure_unconfirmed` says exactly what is known — it was ours, it is not
readable now, and we cannot establish when or how that happened.

The two ignorance states must stay distinct, because they are ignorant about
different things:

- `never_matched` — no evidence it was **ever** owned.
- `departure_unconfirmed` — evidence it **was** owned, insufficient evidence of
  **when or how** it left.

Collapsing either into `previously_owned` would manufacture an archive history
that never happened.

### Departure evidence has two grades

```
departure evidence
├── exact
│   └── archive_operation → timestamp
│
└── bounded
    └── snapshot A (present) → snapshot B (absent)
        └── departure window
```

A bounded departure is not a weaker version of an exact one that should be
rounded to a date. It is a different statement: *the item was present at A and
absent at B; departure occurred somewhere in that interval.* That is strictly
more useful to Arena than a fabricated timestamp, because Arena can reason
about an interval it is told about and cannot detect one that has been
flattened. Only an `archive_operation` collapses the interval to an event.

**This repository can already evidence these grades**, which is why the
taxonomy is derivable rather than speculative:

- `archive_operation` records owner-scoped `delete`, `move`, and `rename`
  actions with `source_path`, `destination_path`, status, and timestamps —
  exact departure evidence.
- Library-state snapshots supply bounded evidence: present in an earlier
  snapshot, absent in a later one, with the interval as the departure window.
- `file_record.scan_status` distinguishes `active` / `missing` / `error`. A
  `missing` record is **not** departure evidence at any grade. It is a read
  failure, and it maps to `departure_unconfirmed`.

So the relation carries a confidence grade and its evidence source, in the same
spirit as the existing reconciliation classifications
(`local_only` / `plex_only` / `duplicate` / `uncertain`). An item that vanished
before Archive Assistant was installed is legitimately `never_matched` — and
saying so is better than inventing a departure date.

### Why `missing` must never age into `previously_owned`

Elapsed time does not distinguish the explanations behind a missing file:

- a disconnected drive
- an unavailable mount
- a permissions failure
- a transient filesystem error
- genuine deletion

All five produce an identical observation, and waiting produces five identical
observations for longer. A rule of the form `missing for 30 days →
previously_owned` would convert an operational heuristic into archive history,
which is precisely the class of error this document exists to prevent. If an
aged state is ever wanted, it belongs as `long_term_missing` *within*
`departure_unconfirmed` — a statement about how long the read has been failing,
never an upgrade to a departure claim.

The governing principle, which applies to both open questions below:

> **When evidence cannot distinguish two explanations, Archive Assistant
> preserves the ambiguity rather than manufacturing a transition.**

This is the same discipline already applied to `uncertain` reconciliation
results, incomplete Plex snapshots, provider authority, and evidence-keyed
review findings.

### Archive biography, not archive inventory

Joining watch history, archive operations, file state, and library snapshots
lets the system reconstruct an item's *biography* rather than its current row.
Two histories that a usage-only model would render identically:

```
item X   watched 2019 → present → watched again 2022
         → delete operation 2025 → absent
         ⇒ previously_owned, exact departure 2025

item Y   watched 2019 → present → drive unavailable 2022
         → still missing
         ⇒ departure_unconfirmed, no departure claim
```

Arena should be able to tell those apart, and can only do so if the fourth
state exists to hold the second case.

The four-way relation in the proposal then falls out, with each cell answerable
from evidence:

| | Owned now | Not owned now |
| --- | --- | --- |
| **Watched** | active part of the archive | archive history — watched, then removed |
| **Not watched** | dead storage candidate | outside the archive entirely |

The questions worth asking sit in the off-diagonal: what did I repeatedly watch
before removing it, what did I acquire and watch once and then delete, and what
do I own today that I have never touched.

That last one is the one with teeth, and it needs a real denominator:

```
dead storage  =  continuously present
               + known observation coverage
               + no recorded viewing
```

not `owned − watched`. The naive subtraction silently counts items that were
unreadable for half the window, or that sat outside the ingestion scope, or
that were acquired last week. That is a category error, and an expensive one if
it ever reaches a deletion recommendation.

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

### Why snapshots and watch history must interleave

Behavioural history alone cannot separate two very different events. Both look
identical from watch data — plays simply stop:

```
snapshot t0  →  watch history  →  snapshot t1  →  watch history  →  snapshot t2
```

Against that interleaving, the archive becomes legible:

- present at `t1`, absent at `t2`, plays stop → **you removed it**
- present at both, plays stop → **you stopped watching it**

Only the second is a behavioural signal. Reading the first as disengagement
would be a straightforward analytical error, and it is the error a
usage-only model is guaranteed to make. Where an `archive_operation` delete
exists, it dates the departure precisely and the snapshot interval is only a
fallback.

This is also what makes the "dead storage" question safe to ask: an item can
only be dead storage if it was continuously present and continuously unwatched
across a known-covered window. Absent snapshots, that sentence has no
denominator.

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
them model files, quality, integrity, storage, or acquisition — nor an archive
that persists across deletion. YouTube Studio is analytically strong because it
owns both the content and the viewing behaviour. The personal equivalent is
archive plus behaviour plus archive evolution plus provider truth, and no media
server is positioned to assemble it: Plex is a media server, and its history is
a byproduct rather than the product.

The questions that are structurally unavailable to them are the ones worth
building:

- Which terabytes are dead storage — never watched, and also large?
- Which acquisitions entered viewing life, and which never did?
- Do high-rewatch titles sit at the worst quality in the archive?
- Does an integrity finding correlate with abandonment, i.e. did the file fail
  rather than the film?
- Is acquisition rate outpacing consumption rate, in bytes as well as titles?

That join — usage against inventory, quality, integrity, and acquisition — is
the defensible surface. Not the hours-watched bar chart.

## Deliberately parked questions

These are parked, not undecided by neglect. Both are governed by the ambiguity
principle above: neither may be closed by inventing a threshold.

**1. Library-state snapshot interval.**
Parked. The interval is an *epistemic resolution* setting, not a scheduling
convenience: it fixes the width of every bounded departure window not backed by
an `archive_operation`. Choose it from operational cost and the temporal
precision actually wanted, then expose the resulting resolution alongside the
coverage record — never from what produces a tidy-looking chart. Whatever is
chosen, a bounded departure stays an interval; it is never rendered as a date.

**2. Should `missing` age into `previously_owned`?**
Answered no, and closed. Elapsed time cannot distinguish a disconnected drive
from a deletion, so no duration threshold can license the transition. A
long-lived read failure may be labelled `long_term_missing` *within*
`departure_unconfirmed`, describing how long the read has failed. It never
becomes a departure claim.

## Other open questions

- Is usage single-owner by definition, or does a household imply per-viewer
  attribution? Plex history is per-`accountID`, so the data supports it and the
  choice is ours. This changes the schema and cannot be retrofitted cheaply.
- Read history over the API, or read `com.plexapp.plugins.library.db` directly?
  Direct reads are richer and faster for a large backfill, but reach into
  another application's private database and require its bundled SQLite build.
  The existing integration-adapter boundary points firmly at the API; this
  should be decided explicitly rather than by drift.
- What is the minimum play duration that constitutes a watch, and is that a
  stored rule or a recompute-time parameter? Making it recompute-time keeps old
  observations honest.
- Does importing an existing Tautulli or Playback Reporting archive count as an
  observation with provenance "imported", and how is a manual import's coverage
  window established? Tautulli in particular would be a strong secondary source
  for the session-duration data Plex history lacks.
- Does a scope-definition change invalidate existing aggregates, or produce a
  second scoped series alongside the first? Recomputation is cleaner; a visible
  discontinuity may be more honest.

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
