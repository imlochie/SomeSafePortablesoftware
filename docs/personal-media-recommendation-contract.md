# Arena Personal Media Recommendation Contract

## Status

**Specification boundary only.** This document does not implement a personal recommendation engine, ranking model, embeddings, taste score, or acquisition bridge.

## Purpose

Define the future boundary between Archive Assistant evidence and Arena personal media recommendation reasoning.

The governing architecture remains:

```text
Archive Assistant knows. Arena thinks. Archive Assistant decides.
```

```text
Archive Assistant
  ├── library truth
  ├── provider truth
  ├── watch-event truth
  ├── analytics
  ├── behavioural signals
  └── explicit preferences
            ↓
    personalisation context
            ↓
          Arena
            ↓
    personal media recommendation
```

## Recommendation semantics

A personal media recommendation is a candidate that Arena determines may be relevant to the operator based on available evidence. It is not:

- an archive deficiency or missing-media finding;
- an acquisition approval, provider request, or download instruction;
- proof that the operator likes or will like the candidate;
- permission to mutate the archive.

Personal recommendations and acquisition recommendations are separate domains.

## Evidence hierarchy

Arena should reason over evidence in this conceptual order:

1. recent observed behaviour;
2. repeated and rewatch behaviour;
3. long-term behavioural patterns;
4. explicit preferences;
5. collection relationship;
6. metadata and content similarity.

This is an evidence-priority model, not a universal numerical weighting scheme. No opaque global taste score should be introduced.

## Evidence classes

### Observed behaviour

May include recent activity, long-term activity, frequency, recency, repeated watches, rewatch intervals, sessions, active periods, media-type patterns, and creator/genre/franchise patterns where the metadata supports them.

### Explicit preferences

May include explicit likes, dislikes, stated interests, exclusions, and manually recorded preferences. Explicit preferences remain separate from observed behaviour. Arena may explain tension between them but must not rewrite one as the other.

Examples:

```text
Observed: frequent horror viewing
Explicit: "I don't generally like horror."
Valid: these evidence classes are in tension.
Invalid: horror is therefore a stored preference.
```

Ownership is not preference. Watching is not liking. A rewatch is evidence of return behaviour, not proof of a favourite.

## Temporal reasoning

The context must preserve the distinction between:

- recent;
- long-term;
- repeated;
- historical;
- inactive or insufficiently observed.

A recent shift must not silently overwrite long-term identity. Historical behaviour must not automatically dominate current interest.

Arena should be able to describe change and uncertainty rather than converting a window comparison into a permanent preference.

## Coverage, scope, and epistemic status

Every recommendation-supporting behavioural claim must retain:

- scope identity;
- coverage information;
- provenance;
- epistemic status;
- relevant observation or signal identifiers;
- observation timestamps where available.

Coverage must propagate from provider observation through watch events, analytics, behavioural signals, and Arena context. The governing rule is:

```text
UNKNOWN ≠ FALSE
```

Incomplete history is not evidence of disinterest. An absent recorded preference is not evidence that no preference exists. Collection-dependent metrics must not be presented as historical facts.

## Candidate discovery

A future personal recommendation system may discover candidates from:

- existing archive items;
- previously owned items where the ownership semantics permit it;
- provider or library metadata;
- explicitly supported external catalogues;
- content related to established behavioural patterns.

Candidate discovery is distinct from acquisition execution. Arena must not infer:

```text
candidate → acquire
```

## Acquisition boundary

`acquisition-intelligence.ts` remains responsible for operational acquisition recommendations, including missing media, archive deficiencies, quality conflicts, provider availability, destinations, storage constraints, jobs, and blockers.

Personalisation evidence must not redefine those semantics and must not be appended to acquisition recommendation evidence merely to simulate personal recommendation.

The only acceptable future transition is explicit and operator-mediated:

```text
personal recommendation
    ↓
operator interest or approval
    ↓
acquisition intelligence
    ↓
controlled acquisition workflow
```

Personal recommendation must never directly create acquisition jobs or archive operations.

## Recommendation explanation

Every eventual recommendation must be explainable through an evidence chain:

```text
recommendation
    ↓
reason
    ↓
behavioural or preference signal
    ↓
analytics aggregate
    ↓
watch events or explicit statement
    ↓
provider observation or operator evidence
```

An explanation must distinguish:

- **FACT** — what Archive Assistant observed or persisted;
- **OBSERVED SIGNAL** — a derived behavioural fact;
- **INTERPRETATION** — Arena's reasoning;
- **UNCERTAINTY** — missing coverage, conflicting evidence, or scope limits.

Arena must not present an interpretation as archive truth.

## Context boundary

The intended future seam is:

```text
GET /api/assistant/personalisation-context
        ↓
Arena personalisation input
        ↓
candidate generation and interpretation
        ↓
evidence-backed recommendation
```

Arena must receive bounded normalized context. It must not access Plex, Jellyfin, provider credentials, private provider databases, the filesystem, or raw analytics storage.

## Prohibited shortcuts

Do not:

- create a second competing recommendation engine inside Archive Assistant;
- create a universal taste score;
- infer explicit preferences from behaviour without an explicit semantic contract;
- treat ownership as preference;
- treat incomplete observation as disinterest;
- expose provider access to Arena;
- let personal recommendations create acquisition jobs directly;
- bypass Archive Assistant approval and authority;
- introduce embeddings solely for convenience;
- compress evidence into opaque scores before the semantics are established;
- merge personal recommendations into acquisition recommendations.

## Implementation gate

Before implementation, audit and reuse compatible existing infrastructure where semantics match. Specifically identify:

- existing Arena recommendation code;
- personalisation concepts;
- candidate models;
- recommendation persistence;
- explanation mechanisms;
- model interfaces;
- ranking mechanisms;
- preference representations.

The existing audit found that the current recommendation implementation is acquisition intelligence, not personal media recommendation. It should remain adjacent to this future boundary.

## Acceptance criteria

An eventual implementation must demonstrate:

1. behavioural evidence reaches Arena only through the defined context boundary;
2. explicit preferences remain separate from observed behaviour;
3. recent and historical evidence remain distinguishable;
4. scope and coverage remain attached to claims;
5. explanations retain provenance;
6. incomplete evidence cannot produce stronger absence claims;
7. personal recommendations remain separate from acquisition recommendations;
8. no automatic acquisition or archive mutation follows a personal recommendation;
9. compatible existing infrastructure is reused where semantics match;
10. no opaque universal taste score is introduced without a separate design decision;
11. recommendations can explain why they were surfaced;
12. uncertainty and conflicting evidence can be represented.

## Current status

The behavioural evidence foundation and bounded personalisation context are implemented. The personal recommendation engine is intentionally not implemented. The next implementation step requires review of this contract against any future Arena recommendation architecture before code is added.
