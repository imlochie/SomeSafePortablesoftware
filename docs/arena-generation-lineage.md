# Arena personalisation generation lineage

## Canonical branch references

This lineage records the two Arena generations identified during the architecture audit:

- **Gen-1:** `arena/01a0a0d9-somesafeportablesoftware`
- **Gen-2:** `arena/01a0b5d9-somesafeportablesoftware`

Gen-1 contains the earlier presentation-oriented personalisation vocabulary. Gen-2 contains the Archive Assistant behavioural evidence foundation and bounded personalisation context.

These generations are not interchangeable contracts.

## Gen-1 classification

Gen-1 fields are legacy presentation or library-state projections. They must not be silently promoted into Gen-2 behavioural truth.

| Gen-1 field | Classification | Gen-2 treatment |
|---|---|---|
| `personalAffinity` | Heuristic presentation signal | Do not normalize as behavioural evidence |
| `personalRelevance` | Heuristic presentation/discovery output | Do not normalize as behavioural evidence |
| `suggestedForYou` | Presentation/discovery output | Do not normalize as preference evidence |
| `personalizedBriefing` | Presentation composition | Do not normalize as behavioural evidence |
| `personalizedBriefing.rank` | Acquisition/presentation ordering | Never treat as taste or relevance ranking |
| `viewCount` | Library-state claim under current identity limitations | Do not treat as owner-scoped watch truth without identity evidence |
| `lastViewedAt` | Library-state claim under current identity limitations | Do not treat as owner-scoped observed behaviour without identity evidence |
| resume offset | Playback-state claim | Do not treat as enjoyment, completion, or preference |
| `watchedMinutes` | Estimated/derived presentation value | Do not treat as canonical behavioural truth |

## Gen-2 authority

Gen-2 is the authoritative behavioural direction:

```text
watch_event
    ↓
watch_session
    ↓
analytics
    ↓
behavioral_signal
    ↓
explicit_preference
    ↓
personalisation-context
    ↓
Arena interpretation
```

Gen-2 evidence carries the semantic dimensions that Gen-1 presentation data did not establish:

- owner scope;
- provider and event identity;
- ownership relationship;
- historical and collection coverage;
- provenance;
- epistemic status;
- rebuildable derivation.

## Intentional omission rule

The absence of Gen-1 personalisation fields from the Gen-2 normalizer and personalisation context is intentional.

```text
Gen-1 presentation fields
        ↓
contract-valid transport
        ↓
Arena ingress
        ↓
intentionally not normalized as behavioural evidence
```

A future developer must not reintroduce a Gen-1 field merely because it is available in a legacy overview or provider projection. Its provenance class must first be re-evaluated against the Gen-2 contract.

## Semantic non-equivalences

```text
viewCount       ≠ owner-scoped observed watch events
lastViewedAt    ≠ owner-scoped observed watch events
resume offset   ≠ enjoyment
watchedMinutes  ≠ preference
playCount       ≠ liked
watched         ≠ liked
owned           ≠ wanted
rewatched       ≠ universally preferred
not_available   ≠ nothing to recommend
briefing rank   ≠ taste ranking
UNKNOWN         ≠ FALSE
```

Arena may interpret valid Gen-2 evidence, but it must not persist the interpretation as a Gen-2 fact or explicit preference without a deliberate domain action.
