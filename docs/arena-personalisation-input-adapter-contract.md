# Arena Personalisation Input Adapter Contract

## Status

**Design and contract slice only.** No adapter, recommendation engine, candidate generator, ranking, scoring, embeddings, model call, preference database, or acquisition integration is implemented by this document.

This contract defines the semantic membrane between Archive Assistant evidence and future Arena reasoning.

```text
Archive Assistant DB/domain
        ↓
GET /api/assistant/personalisation-context
        ↓
Arena input adapter
        ↓
Arena internal evidence model
        ↓
future interpretation and recommendation reasoning
```

The governing rule remains:

```text
Archive Assistant knows. Arena thinks. Archive Assistant decides.
```

---

## 1. Source of truth

The authoritative input surface is:

```text
GET /api/assistant/personalisation-context
```

Archive Assistant remains authoritative for:

- watch-event-derived behaviour;
- analytics aggregates;
- behavioural signals;
- explicit preferences;
- ownership relationship;
- scope;
- coverage;
- provenance;
- epistemic status.

Arena must not reconstruct these facts from Plex, Jellyfin, provider APIs, provider databases, filesystem state, or a duplicate watch-history store.

The adapter consumes the bounded response. It does not query Archive Assistant storage directly.

---

## 2. Proposed Arena input model

This is a proposed specification shape, not an implementation. It intentionally does not mirror the Archive Assistant database tables.

```ts
type EvidenceStatus =
  | "observed"
  | "derived"
  | "coverage-limited"
  | "unknown";

type EvidenceClass =
  | "fact"
  | "observed_behaviour"
  | "explicit_preference"
  | "collection_relationship"
  | "uncertainty";

interface ArenaEvidenceRef {
  signalId?: string;
  eventIds?: string[];
  observationIds?: string[];
  refreshId?: string;
  evidenceKey?: string;
  source: string;
  provider?: string;
  observedAt?: string;
}

interface ArenaScope {
  scopeId: string;
  provider: string;
  account?: string | null;
  mediaTypes: string[];
  libraries?: string[];
  includedEventTypes: string[];
  excludedEventTypes: string[];
  definition?: Record<string, unknown>;
}

interface ArenaCoverage {
  status: "known" | "partial" | "unknown" | "stale";
  historicalCoverageStart?: string | null;
  collectingSince?: string | null;
  lastSuccessfulIngestion?: string | null;
  asOf?: string | null;
  limitations: string[];
}

interface ArenaTemporalEvidence {
  observedAt?: string;
  firstActivityAt?: string;
  lastActivityAt?: string;
  recentWindows?: Array<{
    label: string;
    startsAt: string;
    endsAt: string;
    count?: number;
  }>;
  longTermWindow?: {
    startsAt?: string;
    endsAt?: string;
  };
  rewatchIntervalsDays?: number[];
}

interface ArenaBehaviouralEvidence {
  evidenceClass: "observed_behaviour";
  profile: "recent" | "long_term" | "collection";
  signalType: string;
  subjectType: string;
  subjectIdentity: string;
  value: Record<string, unknown>;
  status: EvidenceStatus;
  temporal: ArenaTemporalEvidence;
  scope: ArenaScope;
  coverage: ArenaCoverage;
  provenance: ArenaEvidenceRef;
}

interface ArenaExplicitPreference {
  evidenceClass: "explicit_preference";
  subjectType: string;
  subjectIdentity: string;
  statement: string;
  observedAt: string;
  scope: ArenaScope;
  provenance: ArenaEvidenceRef;
  status: "observed";
}

interface ArenaCollectionRelationship {
  evidenceClass: "collection_relationship";
  subjectType: string;
  subjectIdentity: string;
  relationship:
    | "currently_owned_and_watched"
    | "currently_owned_and_unwatched"
    | "previously_owned_and_watched"
    | "departure_unconfirmed"
    | "never_matched";
  status: EvidenceStatus;
  scope: ArenaScope;
  coverage: ArenaCoverage;
  provenance: ArenaEvidenceRef;
}

interface ArenaPersonalisationInput {
  schemaVersion: string;
  generatedAt: string;
  observedBehaviour: ArenaBehaviouralEvidence[];
  explicitPreferences: ArenaExplicitPreference[];
  collectionRelationships: ArenaCollectionRelationship[];
  coverage: ArenaCoverage[];
  scopes: ArenaScope[];
  uncertainties: Array<{
    evidenceClass: "uncertainty";
    kind: "unavailable" | "partial" | "stale" | "empty" | "non_authoritative";
    statement: string;
    scope?: ArenaScope;
    coverage?: ArenaCoverage;
    provenance?: ArenaEvidenceRef;
  }>;
}
```

The model intentionally contains evidence and uncertainty, not `likes`, `strong_interest`, `tasteScore`, `resolvedPreference`, or `willEnjoy` fields.

### Current implementation limitation

The current Archive Assistant context already exposes behavioural values, scope, coverage, epistemic status, and provenance data. The current context does not yet expose every field represented above as a first-class field. In particular, a future adapter may need a stable signal handle and richer explicit scope definitions. Those are open contract questions, not changes to be made in this slice.

---

## 3. Evidence classes

The adapter must preserve the following classes without resolving them into one another:

```text
FACT
    what Archive Assistant observed or persisted

OBSERVED BEHAVIOUR
    a derived description of watch activity

EXPLICIT PREFERENCE
    an operator-authored statement or recorded preference

INTERPRETATION
    Arena reasoning about what evidence might mean

UNCERTAINTY
    limits, missing coverage, stale observations, or conflicting evidence
```

At the input boundary, Arena receives facts and observations. It does not receive precomputed personal conclusions.

Valid input:

```text
watchesLast90Days = 7
rewatchCount = 6
firstWatchedAt = ...
lastWatchedAt = ...
provenance = ...
coverage = ...
```

Invalid input unless explicitly recorded as a preference:

```text
strong_interest = true
likes_scifi = true
prefers_creator_x = true
```

Example interpretation ladder:

```text
Archive Assistant fact:
  Blade Runner was recorded as watched four times.

Behavioural evidence:
  Blade Runner has repeated-viewing evidence.

Arena interpretation:
  Blade Runner may have unusually strong personal relevance.

Not permitted as an automatic persistence step:
  operator likes cyberpunk.
```

---

## 4. Behavioural mapping

The adapter should map current signals as follows.

### Recent behaviour

Source concepts:

- recent activity windows;
- watches in the last 30 and 90 days;
- last watched time;
- recent media-type activity where available;
- recent creator, genre, franchise, or era activity only where Archive Assistant has established those dimensions.

Arena meaning:

```text
observed_behaviour / recent
```

It is not a permanent preference.

### Long-term behaviour

Source concepts:

- total watches;
- first and last activity;
- active months;
- long-term recurring subjects;
- historical ownership/watch relationship.

Arena meaning:

```text
observed_behaviour / long_term
```

It must retain historical coverage and scope.

### Rewatch behaviour

Source concepts:

- first watch;
- repeat count;
- rewatch intervals;
- last return.

Arena meaning:

```text
observed_behaviour / rewatch
```

A rewatch is evidence of return behaviour, not proof of a favourite or a positive preference.

### Collection relationship

The adapter must preserve the distinction between:

- currently owned and watched;
- currently owned but unwatched;
- previously owned and watched;
- departure unconfirmed;
- never matched.

These are relationship states, not preference labels.

The distinction remains subject to the existing ownership epistemics:

```text
UNKNOWN ≠ FALSE
```

---

## 5. Explicit preferences

Explicit preferences cross the boundary separately from observed behaviour.

Example:

```text
Explicit preference:
  "I don't want horror recommendations."

Observed behaviour:
  Seven horror films recorded in the recent period.
```

The adapter exposes both records. It does not produce:

```text
resolved_preference = horror
resolved_preference = not_horror
```

Arena may later reason that the evidence classes conflict. It must not rewrite either source.

The adapter must also preserve the distinction between:

```text
no recorded preference
```

and:

```text
recorded preference against a subject
```

---

## 6. Scope

Every aggregate and signal crossing the boundary must carry a scope identity.

The scope should be capable of representing, where known:

- `scopeId`;
- provider;
- account;
- media types;
- selected libraries;
- included event types;
- excluded event types;
- scope definition or version.

For the current Plex context, this includes at minimum the provider and event/library scope available from ingestion. Scope changes must not silently alter the meaning of an existing signal series.

An aggregate without scope is a number without units.

If the current source cannot provide a complete scope definition, the adapter represents that limitation as uncertainty rather than inventing one.

---

## 7. Coverage

Coverage crosses the boundary as first-class data.

The adapter must preserve:

- historical coverage start;
- collection start;
- last successful ingestion;
- observation age/as-of time;
- known covered periods;
- partial or unknown periods;
- metric-specific limitations.

Example:

```text
Plex history:
  available from 2019-04-17

Session collection:
  begins 2026-09-19
```

Arena may reason about historical play frequency from the first period. It may not infer historical completion or abandonment from the second period’s absence of earlier session data.

Missing coverage must never be converted into negative evidence.

```text
No recorded horror watches
```

does not mean:

```text
The operator does not watch horror.
```

---

## 8. Provenance

The adapter should preserve handles instead of copying the entire Archive Assistant history.

Minimum provenance considerations:

- signal identifier;
- event identifiers where applicable;
- observation identifiers where available;
- refresh or ingestion identifier where available;
- evidence key;
- observed timestamp;
- source/provider;
- scope identifier.

The future recommendation explanation should be able to express, in effect:

> This interpretation was influenced by repeated viewing evidence in the covered Plex history.

That statement must be traceable through:

```text
Arena interpretation
    ↓
Arena evidence handle
    ↓
behavioural signal
    ↓
watch events
    ↓
provider observation
```

The adapter must not claim stronger provenance than the source supplies.

---

## 9. Epistemic status

Current Archive Assistant statuses map into Arena without upgrade:

| Archive Assistant status | Arena meaning |
|---|---|
| `observed` | Evidence was directly observed or persisted by Archive Assistant |
| `derived` | Archive Assistant derived the value from canonical observations |
| `coverage-limited` | The fact is usable only within an explicit coverage boundary |
| `unknown` | The fact cannot currently be established |

Arena must not convert:

```text
unknown → false
coverage-limited → complete history
unmatched → never owned
observed behaviour → explicit preference
```

Archive Assistant owns authority logic. Arena consumes the resulting status and limitations.

---

## 10. Temporal representation

The adapter preserves temporal data rather than creating a static preference.

It should carry, where available:

- `observedAt`;
- `firstActivityAt`;
- `lastActivityAt`;
- recent window boundaries and counts;
- long-term window boundaries;
- rewatch intervals;
- coverage boundaries;
- signal generation time.

This allows future Arena reasoning to distinguish:

```text
historically watched X heavily
```

from:

```text
recently shifted toward Y
```

No change detection or trend interpretation is implemented by this contract.

---

## 11. Conflicting evidence

The adapter exposes conflicting evidence side by side.

Examples:

```text
Explicit:
  "I dislike horror."

Observed:
  high recent horror activity.
```

```text
Long-term:
  frequent science-fiction viewing.

Recent:
  no science-fiction activity for six months.
```

The input retains both records and their temporal, scope, coverage, and provenance information.

The adapter does not emit:

```text
resolved_preference = horror
resolved_preference = not_horror
resolved_interest = science_fiction
```

unless such a value already exists as an explicit authoritative preference.

---

## 12. Candidate boundary

The adapter supplies evidence. It does not decide that a title should be recommended.

Because the existing audit found no reusable personal candidate abstraction, candidate generation remains a future Arena concern:

```text
personalisation evidence
    ↓
future Arena candidate discovery
    ↓
future Arena recommendation reasoning
```

The adapter must not create acquisition candidates, provider requests, review items, jobs, or archive operations.

---

## 13. Recommendation and acquisition boundaries

The intended future flow is:

```text
Archive Assistant
    ↓
personalisation-context
    ↓
Arena input adapter
    ↓
Arena evidence model
    ↓
future candidate generation
    ↓
future recommendation reasoning
```

The separate acquisition transition is:

```text
personal recommendation
    ↓
operator expresses interest or explicitly requests acquisition
    ↓
acquisition intelligence
    ↓
review / approval
    ↓
controlled execution
```

The adapter must never directly invoke acquisition intelligence as a consequence of behavioural evidence.

---

## 14. Arena-owned state

Default authority allocation:

```text
raw behavioural truth      → Archive Assistant
explicit preference        → Archive Assistant
analytics facts            → Archive Assistant
behavioural signals        → Archive Assistant
Arena interpretation       → Arena, if and when explicitly designed
```

Arena may eventually persist a recommendation explanation or a user interaction with a recommendation, but that is a separate design decision.

Arena must not persist inferred tastes as permanent preferences.

Arena must not maintain a second behavioural database.

Arena must not write behavioural facts back to Archive Assistant merely because it formed an interpretation.

---

## 15. Deterministic and model-assisted reasoning

The input contract supports both future deterministic reasoning and future model-assisted reasoning.

Neither is implemented here.

An eventual model should receive:

- bounded evidence records;
- compact recent and long-term summaries;
- explicit preferences separately;
- scope and coverage;
- provenance handles;
- uncertainty and conflict records.

It should not receive:

- raw Plex databases;
- provider credentials;
- filesystem paths;
- uncontrolled entire watch-history dumps;
- unrestricted Archive Assistant database state.

The adapter is the minimisation boundary.

---

## 16. Information minimisation

The adapter should forward only evidence required for the reasoning task.

It should not automatically forward:

- all watch events;
- all archive records;
- all provider inventory;
- all metadata;
- private credentials or operational state.

However, minimisation must not become opaque compression.

The desired chain is:

```text
evidence
    ↓
provenance handle
    ↓
Arena interpretation
```

Not:

```text
evidence
    ↓
mysterious score
```

A task-specific context may include selected signal records and their event handles. A future design must specify the selection rule rather than silently truncating evidence.

---

## 17. Failure semantics

| Context state | Required Arena behavior |
|---|---|
| Unavailable | Do not invent personalisation. State that the context could not be obtained. |
| Partial | Reason only within known evidence and expose the limitation. |
| Stale | Preserve observation age and avoid presenting it as current behaviour. |
| Empty | Distinguish no evidence from evidence of no interest. |
| Non-authoritative | Do not support stronger absence or preference claims. |
| Conflicting | Expose the conflict; do not silently resolve it. |
| Unknown coverage | Treat absence as unknown, not false. |

A failure in the personalisation context must not trigger provider access, local database fallback, filesystem inspection, or a copied Arena watch-history store.

---

## 18. Contract compatibility

| Personal media contract requirement | Adapter support | Classification |
|---|---|---|
| Behavioural evidence input | `/api/assistant/personalisation-context` provides source material | SUPPORTED BY INPUT |
| Recent behaviour | Recent profiles and windows are available | SUPPORTED BY INPUT |
| Long-term behaviour | Long-term profiles and activity are available | SUPPORTED BY INPUT |
| Rewatch evidence | Rewatch counts and intervals are available where derivable | SUPPORTED BY INPUT |
| Collection relationship | Ownership relationship is available, with current source granularity limits | SUPPORTED BY INPUT |
| Explicit preference | Separate `explicitPreferences` collection | SUPPORTED BY INPUT |
| Scope | Scope identity is present; richer scope definition may need future source support | SUPPORTED BY INPUT / OPEN DETAIL |
| Coverage | Historical and collection coverage is present | SUPPORTED BY INPUT |
| Provenance | Signal/event provenance is present; stable first-class handles need confirmation | SUPPORTED BY INPUT / OPEN DETAIL |
| Epistemic status | `observed`, `derived`, `coverage-limited`, and `unknown` are available | SUPPORTED BY INPUT |
| Uncertainty | Coverage and status limitations are available; conflict envelope is adapter responsibility | REQUIRES ARENA INTERPRETATION |
| Conflicting evidence | Separate records can be passed without resolution | REQUIRES ARENA INTERPRETATION |
| Candidate discovery | No personal candidate abstraction exists | NOT REPRESENTABLE YET |
| Recommendation reasoning | No Arena reasoning component exists | NOT REPRESENTABLE YET |
| Ranking | No personal ranking exists | NOT REPRESENTABLE YET |
| Explanation | Provenance source exists, but no Arena explanation layer exists | REQUIRES ARENA INTERPRETATION |
| Acquisition separation | Existing acquisition layer is separate | SUPPORTED BY INPUT / ARCHITECTURAL RULE |
| Operator-mediated acquisition transition | No bridge exists, intentionally | NOT REPRESENTABLE YET |

---

## 19. Security and authority

The adapter must not grant Arena:

- Archive Assistant database access;
- Plex or Jellyfin credentials;
- filesystem access;
- provider mutation;
- archive mutation;
- acquisition approval;
- acquisition execution.

The only intended input is the bounded personalisation context response.

Archive Assistant remains the owner of observation, persistence, coverage, provenance, and operational decisions.

---

## 20. Epistemic rules

### Arena may claim

If the context supports it, Arena may say:

- the operator has recorded repeated viewing of a subject;
- recent activity is higher or lower than a defined comparison window;
- historical viewing extends to a stated coverage boundary;
- a signal is observed or derived within a defined scope;
- explicit preference and observed behaviour are in agreement or conflict;
- a candidate may be relevant as an interpretation, with uncertainty stated.

### Arena may not claim from this input alone

Arena may not claim:

- observed behaviour proves liking;
- ownership proves preference;
- one watch establishes a stable interest;
- absence from incomplete history proves disinterest;
- a recommendation guarantees enjoyment;
- an inferred interpretation is an explicit preference;
- a personal recommendation authorizes acquisition;
- a stale or partial signal describes current behaviour without qualification.

---

## 21. Evidence lifecycle

```text
provider observation
    ↓
Archive Assistant watch event
    ↓
Archive Assistant analytics
    ↓
Archive Assistant behavioural signal
    ↓
personalisation-context API
    ↓
Arena input adapter
    ↓
Arena evidence model
    ↓
future Arena interpretation
    ↓
future evidence-backed personal recommendation
```

The adapter is a semantic translation boundary, not a second analytics engine.

---

## 22. Open questions

These questions remain intentionally unresolved:

1. What stable public `scopeId` and scope-version format should the context expose?
2. Should scope changes produce parallel series, or should historical aggregates be recomputed under a new scope?
3. What stable public identifier should be used for a behavioural signal?
4. Should event identifiers be exposed individually, or through bounded evidence bundles?
5. What refresh/ingestion identifier is required for recommendation traceability?
6. How should context selection be requested for a specific Arena task without exposing the entire history?
7. What is the maximum evidence window or record count for model-assisted reasoning?
8. Which metadata dimensions are authoritative enough for creator, genre, franchise, and era signals?
9. How should previously owned media be represented when identity continuity is uncertain?
10. What Arena-owned persistence, if any, is appropriate for recommendation explanations or operator feedback?
11. How should explicit preference revocation and temporal preference changes be represented?
12. What exact operator action constitutes interest before an acquisition handoff is permitted?
13. Should personal recommendations be ephemeral, persisted, or versioned?
14. What structured output contract should future Arena reasoning use for fact, signal, interpretation, and uncertainty?
15. How should stale context be surfaced to a model versus a deterministic reasoning path?

No open question is resolved by this document.
