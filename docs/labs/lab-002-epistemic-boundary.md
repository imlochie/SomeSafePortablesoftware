# Lab-002: Behavioural epistemic boundary

## Status

Adversarial validation specification for the Gen-1/Gen-2 Arena boundary. This lab does not add recommendation logic or a reasoning engine.

## Canonical fixture generations

- Gen-1: `arena/01a0a0d9-somesafeportablesoftware`
- Gen-2: `arena/01a0b5d9-somesafeportablesoftware`

Gen-1 is used as a legacy vocabulary fixture. Gen-2 is the authoritative evidence direction.

## Central question

Can a future Arena adapter distinguish:

1. what happened;
2. what Archive Assistant can establish happened;
3. what might be inferred from what happened?

The lab must fail if those layers are treated as interchangeable.

## Required adversarial cases

| Case | Input | Permitted conclusion | Forbidden conclusion |
|---|---|---|---|
| Playback state | Resume offset only | Playback state exists | The operator enjoyed it or completed it |
| Legacy count | Gen-1 `viewCount` without owner identity proof | Legacy library-state claim | Owner-scoped observed watch behaviour |
| Legacy timestamp | Gen-1 `lastViewedAt` without owner identity proof | Legacy library-state claim | The operator watched it at that time |
| Single play | One normalized `watch_event` | One recorded play | The operator likes it |
| Repeated plays | Multiple normalized events | Repeated viewing evidence | Universal preference or favourite |
| Rewatch | Multiple events for the same identity | Return behaviour / rewatch evidence | The reason for returning is known |
| Ownership | Current archive match | Currently owned relationship | The operator wants it |
| No current match | No current archive match | No current archive match | Previously owned, never owned, or disinterest without evidence |
| Confirmed departure | Archive operation confirms removal | Previously owned | No longer desired |
| Unconfirmed departure | Ownership evidence plus unavailable filesystem/library observation | Departure unconfirmed | Previously owned |
| No ownership evidence | Historical event with no ownership evidence | Never matched | Previously owned |
| Provider unavailable | No current provider response | Unknown current state | Nothing is relevant or unavailable everywhere |
| Incomplete coverage | No records in an uncovered period | Unknown | No interest during that period |
| Historical activity | Long-term repeated viewing | Historical behavioural evidence | Current interest without recent evidence |
| Recent activity | Concentrated recent viewing | Recent behavioural evidence | Permanent preference |
| Owned item | Item exists in archive | Owned | Wanted, liked, or intended to watch |
| Unwatched owned item | Owned with no watch event | Owned but no recorded consumption | Never interested |
| Not available | No current availability evidence | Availability is unknown | Nothing to recommend |
| Acquisition ordering | Gen-1 briefing rank or acquisition priority | Presentation/operational ordering | Taste or personal relevance ranking |
| Explicit conflict | Explicit dislike plus observed watches | Both evidence classes are in tension | Resolve one into the other |

## Lab assertions

A valid future Arena input adapter must satisfy:

```text
assert legacyPresentationField !== behaviouralEvidence
assert resumeOffset !== enjoyment
assert oneWatch !== liked
assert watched !== liked
assert owned !== wanted
assert rewatched !== universallyPreferred
assert noCurrentMatch !== previouslyOwned
assert departureUnconfirmed !== previouslyOwned
assert unknown !== false
assert incompleteCoverage !== disinterest
assert acquisitionPriority !== tasteRanking
assert explicitPreference !== inferredPreference
```

## Evidence ladder fixture

The following should remain representable as separate layers:

```text
FACT
  Blade Runner was recorded four times.

OBSERVED SIGNAL
  Blade Runner has repeated-viewing evidence.

TEMPORAL SIGNAL
  The four events include two in the last 90 days.

COLLECTION FACT
  Three related films are currently owned and unwatched.

INTERPRETATION
  The recent repeated viewing may indicate current relevance.

UNCERTAINTY
  The viewing record does not establish why the operator watched them.
```

The last two lines must not be persisted backwards as behavioural truth or explicit preference.

## Expected boundary behaviour

Gen-1 fields may remain available to legacy presentation code, but they must be classified as legacy presentation or library-state claims. They must not enter the Gen-2 personalisation evidence model unless a future contract explicitly establishes owner identity, provenance, and semantics.

Gen-2 facts must cross through:

```text
Archive Assistant
    ↓
personalisation-context
    ↓
Arena input adapter
```

The adapter must not:

- query Plex, Jellyfin, provider APIs, or the filesystem;
- create candidates;
- rank candidates;
- infer preferences;
- persist taste;
- create acquisition work;
- approve or execute archive operations.

## Lab outcome categories

Each future implementation/test result should be classified as:

- **PASS** — the distinction is preserved;
- **FAIL** — a stronger claim was produced than the evidence permits;
- **NOT REPRESENTABLE** — the current Arena implementation has no reasoning/input path for the case;
- **SOURCE LIMITATION** — Archive Assistant does not currently expose enough authoritative evidence.

`NOT REPRESENTABLE` is not permission to invent a fallback inference.

## Completion condition

Lab-002 is complete when a future Arena input/reasoning implementation can run these cases and demonstrate that it preserves:

- evidence class;
- scope;
- coverage;
- provenance;
- epistemic status;
- temporal distinction;
- ownership state;
- uncertainty;
- the separation between interpretation and Archive Assistant truth.

Until that implementation exists, this document is the authoritative adversarial test specification rather than a claim that Arena reasoning already passes.
