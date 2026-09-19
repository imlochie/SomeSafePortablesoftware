# Lab-004: Preference and intent boundary

## Status

Design-only decision record. This lab does not add preference reasoning, recommendation logic, Arena machinery, or producer behaviour.

## Purpose

Determine whether user-controlled instructions should remain one semantic layer or split into distinct concepts before any implementation is attempted.

The lab follows the established direction:

```text
canonical evidence
        ↓
A. conclusions
        ↓
B. composition
        ↓
C. interpretation
        ↓
D. preference and intent
        ↓
E. recommendation
```

The layers are related, but they do not inherit one another's epistemic status.

## Central questions

1. Are preference, intent, constraints, and discovery controls the same semantic object?
2. Can D affect what evidence says?
3. Can D change a C interpretation, or only what the system does with it?
4. Where does D meet candidate generation and recommendation policy?
5. Can D produce useful discovery when no behavioural evidence exists?

## Working distinctions to test

| Candidate concept | Example | Initial hypothesis |
|---|---|---|
| Explicit preference | `I want more experimental cinema.` | User statement; independently provenance-bearing |
| Intent | `Find me something weird tonight.` | Contextual request, not necessarily a stable preference |
| Constraint | `Do not recommend horror.` | User-controlled policy boundary |
| Discovery control | `Prioritize unwatched titles.` | Product selection/configuration, not a claim about the user |
| Behavioural evidence | `The operator watched 14 horror films.` | Archive-derived fact; never rewritten by D |
| Interpretation | `Signals are consistent with current interest in horror.` | C-layer proposition with its own ceiling and lineage |

These distinctions remain hypotheses until adversarial cases establish whether they can safely share a contract.

## Layer invariants

### A: Conclusions

A states what the available evidence independently establishes. Each conclusion retains its evidence class, scope, temporal bounds, provenance, and epistemic status.

### B: Composition

B relates independently established conclusions and evidence. It may contain evidence that is meaningful but not independently conclusion-formable under the current calculus.

A missing A-level conclusion does not erase evidence from B. B membership does not license a stronger claim by itself.

### C: Interpretation

C introduces a new proposition about what A and B may mean. It has its own claim kind, licensing rule, epistemic ceiling, provenance, and uncertainty. It cannot upgrade A or B retroactively.

Permitted example:

```text
The available preference and viewing signals are consistent with current
interest in experimental cinema.
```

Forbidden automatic upgrades:

```text
The user likes experimental cinema.
Experimental cinema is the user's favourite.
The user definitely wants more experimental cinema.
```

### D: Preference and intent

D represents what the user currently wants the system to do, not what the archive proves about the user. D must not rewrite canonical evidence or silently alter C's interpretation.

D may affect recommendation policy or candidate presentation through an explicit boundary, but that policy effect must remain distinguishable from evidence and interpretation.

### E: Recommendation

E is the system response to available evidence, reasoning, and current user-controlled policy. E must not write conclusions back into A, change C into fact, or convert a recommendation decision into a preference claim.

## Adversarial cases

### Case 1: Behaviour conflicts with a constraint

```text
A: The operator watched 14 horror films.
C: The viewing pattern may be consistent with recent horror activity.
D: Do not recommend horror.
```

Required checks:

- The historical behaviour remains true.
- The interpretation is not rewritten merely because D conflicts with it.
- Horror may be suppressed by recommendation policy.
- The system may explain that suppression as a current user constraint, not as loss of interest.

### Case 2: Sparse behaviour and explicit exploration intent

```text
A: The operator rarely watched animation.
D: I am exploring animation right now.
```

Required checks:

- The historical observation remains sparse.
- The system does not infer that the operator has always preferred animation.
- Discovery may prioritize animation because of current D.
- D does not require prior personalisation evidence.

### Case 3: No behavioural evidence

```text
A: No relevant behavioural evidence.
D: Give me weird 90-minute films tonight.
```

Required checks:

- A remains empty or unknown for this subject.
- Recommendation/discovery can still act on the current request if the candidate system supports it.
- No behavioural conclusion is manufactured.
- No stable preference is persisted unless the user explicitly creates one.

### Case 4: Explicit preference without a recommendation request

```text
D: I want more experimental cinema.
No current discovery request.
```

Required checks:

- The statement remains an explicit preference record.
- It does not become a recommendation decision by itself.
- It does not alter historical evidence or create an interpretation automatically.

### Case 5: Configuration versus preference

```text
Discovery control: prioritize unwatched titles.
Explicit preference: I love Wong Kar-wai.
```

Required checks:

- The control is not represented as a taste claim.
- The explicit statement retains preference-specific provenance.
- Candidate policy can consume both without conflating them.

### Case 6: Interpretation does not override intent

```text
C: Signals are consistent with current interest in horror.
D: I am taking a break from horror.
```

Required checks:

- C remains an interpretation of the evidence.
- D controls current discovery policy.
- The system does not claim that the archive disproves the interpretation.

### Case 7: Intent does not rewrite preference

```text
Existing preference: I want more experimental cinema.
Current intent: Find something familiar tonight.
```

Required checks:

- The stable preference remains persisted and identifiable.
- The contextual intent may take precedence for the current request.
- The system does not mutate the preference merely because the request is different.

### Case 8: Explicit negative instruction

```text
D: Do not recommend superhero films.
A: The operator has watched superhero films repeatedly.
```

Required checks:

- Repeated viewing remains behavioural evidence.
- The negative instruction is not converted into dislike.
- Candidate suppression is explainable as a current user instruction.

## Questions the lab must resolve

### Is D one layer?

Do preference, intent, constraint, and discovery control share:

- the same identity model;
- the same lifetime;
- the same scope;
- the same update semantics;
- the same provenance requirements;
- the same downstream policy effect?

If not, they must not be collapsed merely for contract convenience.

### Does D affect evidence?

Initial decision: no.

D must not change watch events, behavioural aggregates, temporal windows, ownership facts, or coverage. It must not rewrite A or B.

### Does D affect C?

Initial decision: no semantic rewrite.

D may be supplied as context to a future recommendation policy, but C remains the interpretation of its supporting evidence. If a future system produces a new interpretation that considers D, that must be an explicitly typed, newly licensed claim rather than mutation of the original C claim.

### Where does D meet recommendations?

This remains open for the lab. Candidate architectures are:

```text
Evidence → reasoning → candidate generation → D policy → presentation
```

or:

```text
Evidence ──────┐
Reasoning ─────┤
D controls ────┼→ recommendation decision
Intent ───────┘
```

The lab must test which boundary preserves explainability and prevents D from contaminating evidence-derived claims.

## Expected outcome categories

- **SEPARATE LAYERS** — preference, intent, constraints, or controls require distinct semantics.
- **SHARED D CONTRACT** — the concepts can share a contract without semantic loss, with explicit subtypes.
- **NOT REPRESENTABLE** — the current architecture cannot preserve the distinction.
- **SOURCE LIMITATION** — an authoritative user-controlled source is missing.
- **POLICY BOUNDARY REQUIRED** — D can be represented, but recommendation consumption needs an explicit policy seam first.

## Non-goals

This lab must not:

- implement preference or intent reasoning;
- modify Arena, Gate 6, Gate 7, or the renderer;
- alter temporal reasoning;
- infer preferences from watching, ownership, genre, or collection state;
- create taste scores or rankings;
- generate recommendations;
- introduce LLM calls, embeddings, or feedback learning;
- change the existing explicit preference provenance seam.

## Decision gate

No implementation should begin until the lab records decisions for:

1. the semantic split between preference, intent, constraints, and discovery controls;
2. the provenance and lifetime of each subtype;
3. the boundary between C interpretation and D user control;
4. the recommendation policy interface consuming D;
5. how conflicts between historical evidence, interpretation, and current D are explained.

The governing invariant is:

```text
Evidence can compose upward.
Certainty cannot flow downward.
User control can affect policy.
User control cannot rewrite history.
```
