# Universal Archive Action Engine

Archive Assistant observes, understands, explains, and proposes. The Action
Layer is the substrate that lets it also **change the archive safely**, so a
finding no longer ends with "…and now you go fix it yourself."

```text
     OBSERVE → UNDERSTAND → EXPLAIN → PROPOSE → REVIEW
                                                  ↓
                                      ┌───────────────────┐
                                      │   ACTION LAYER    │
                                      │ approve preflight │
                                      │ execute  verify   │
                                      │ record   revert   │
                                      └───────────────────┘
                                                  ↓
                            RESULT → ARCHIVE CHANGES → OBSERVE
```

Every finding should be able to answer four questions. The engine makes those
answers structural rather than per-feature:

| Question | Where it is answered |
| --- | --- |
| What can I do about this? | `GET /api/action-capabilities`, capability previews such as `GET /api/archive/naming-actions` |
| What exactly will change? | `ActionProposal.steps[]` — each step carries `before` and `after` |
| What needs my approval? | `requiresApproval`, `risk`, and the linked review-queue item |
| What happens after Execute? | `preflight`, `execution`, `verification`, `postflight`, `events[]`, and `revert` |

## Objects

```ts
ActionProposal {
  id, ownerId, type, source, reason, status, risk
  target, evidence
  steps: ActionStep[]
  approval, preflight, execution, verification, revert, postflight
  planHash, counts, events
  createdAt, approvedAt, executedAt, completedAt
}

ActionStep {
  stepIndex, type, status, selected, summary
  target, before, after
  preflight, execution, verification, revert
}
```

`ActionStep.before` / `after` are the reviewable substance: they are exactly
what the operator sees as *Before → After*, and exactly what preflight
re-validates before anything runs.

## Action types

Strictly typed, with an honest support flag so the product never claims a
capability it does not have:

| Type | Supported | Mutates files | Reversible |
| --- | --- | --- | --- |
| `rename` | yes | yes | yes |
| `move` | yes | yes | yes |
| `import` | yes | yes | yes |
| `delete` | declared | yes | no |
| `restore` | declared | yes | yes |
| `reconcile` | yes | **no** | yes |
| `acquire` | declared | no | yes |
| `link` / `unlink` | declared | no | yes |
| `metadata_update` | declared | no | yes |
| `plex_sync` | declared | no | no |

Declared families exist so the vocabulary is complete and the UI can say "not
yet available." They refuse to plan or execute rather than half-working.

`reconcile` is the first supported family that changes **no bytes on disk** — it
records a confirmed identity link between a local file and a Plex item in
`media_identity_link`. It exists partly to prove the engine is not merely a
file-mover with a general-sounding name; see "What the second family taught us"
below.

## Lifecycle and its guarantees

```text
proposed ──select──> proposed ──approve──> approved ──preflight──> ready
                                                                     │
                                              execute (confirmed)    ↓
                        reverted <──revert── completed / partially_completed
```

1. **Propose** — inert. Creating a proposal changes nothing on disk. Identical
   evidence is idempotent and returns the existing proposal.
2. **Select** — batch by default; individual steps can be deselected before
   approval. Deselected steps become `skipped` and are never touched.
   Selection is locked once approved.
3. **Approve** — explicit and durable, recorded as an `operation_approval`
   review item. Approval alone still changes nothing.
4. **Preflight** — re-checks every safety condition immediately before
   execution and never mutates: source exists, no destination collision
   (including two steps in one plan racing for the same path), destination
   inside a configured archive volume, directory writable, enough free space.
   It also re-derives `planHash`; if the plan changed after approval the
   proposal fails with `PLAN_CHANGED`.
5. **Execute** — requires `confirmed: true`, a `ready` status, and a still-valid
   approval. Each step is verified immediately after it runs.
6. **Verify / Record** — per-step verification plus a history event for every
   phase, then an archive rescan, Plex refresh, and reconciliation so the loop
   returns to OBSERVE.
7. **Revert** — restores completed steps newest-first.

Partial failure is a first-class outcome: a batch where some steps fail becomes
`partially_completed`, and revert restores only what actually succeeded.

## Adding a capability

Implement one `ActionHandler` in `services/action-engine/registry.ts`:

```ts
{
  type, supported, mutatesFiles, reversible, risk, description,
  summarize(step),
  preflight(step, context),
  execute(step, context),
  verify(step, context),
  revert(step, context),
}
```

Then the intelligence feature only maps findings to steps. It writes no
approval, execution, verification, or rollback logic. `services/naming-actions.ts`
is the reference implementation.

## Reference implementation: naming → rename

```text
Finding      "N files have inconsistent naming"
   ↓         GET  /api/archive/naming-actions      (preview, no writes)
Proposal     POST /api/archive/naming-actions      (exact file mappings)
   ↓         POST /api/action-proposals/{id}/selection
Review       POST /api/action-proposals/{id}/approve
   ↓         POST /api/action-proposals/{id}/preflight
Execute      POST /api/action-proposals/{id}/execute   {"confirmed": true}
   ↓
Verify/History  proposal.verification + proposal.events
Revert       POST /api/action-proposals/{id}/revert    {"confirmed": true}
```

Only findings the naming layer marked executable become steps; uncertain and
colliding findings stay advisory.

## Legacy compatibility

`/api/archive-operations` keeps its exact contract and response shape, but
`services/archive-operations.ts` is now a thin adapter: each legacy operation is
an `ActionProposal` with a single `ActionStep`. There is one execution path, and
the same operation is visible through both APIs.

## Safety boundary

The AI does not perform actions. It may observe, propose, and read; it may not
approve. Approval and execution are explicit operator decisions against a
deterministic control plane — a natural-language operator above an archive
operating system, not a chat shell with root privileges.

## What the second family taught us

`rename`, `move` and `import` all share three private helpers — `stepPaths()`,
`preflightFilesystemMutation()` and `verifyMovedFile()`. Every one of them is
"move bytes from path A to path B", so none of them could tell us whether the
*lifecycle* was genuinely universal or just well-factored file plumbing.

`reconcile` was chosen next precisely because it breaks those assumptions: no
source to `stat`, no destination collision, nothing to `rename` back. What
survived unchanged is the part that was supposed to be universal:

- the proposal/step/selection model,
- propose → approve → preflight → execute → verify → record → revert,
- plan-hash tamper detection,
- batch selection with per-step opt-out,
- the review surface, history and revert affordances.

What had to change was **vocabulary, not structure**:

| Assumption | Was | Now |
| --- | --- | --- |
| Step column headings | hardcoded `OLD NAME` / `NEW NAME` | per action type (`LOCAL FILE` / `PLEX ITEM`) |
| Step identity | filename, else path basename | explicit planner `label` wins over a derived basename |
| "before" is replaced | always struck through | only when the action replaces it |
| Preflight checks | fixed file-oriented list | emitted only for fields the engine actually reported |
| Copy | "written to disk" | "written" or "recorded" per `mutatesFiles` |

Two rules came out of this and should be applied to the next family:

1. **Never render a check the handler did not report.** The review surface now
   emits a preflight line only when the field is present in the step payload,
   so a new family cannot inherit a reassurance that is meaningless for it.
2. **Group membership must key off engine facts, not action semantics.** The
   `CREATES A NEW FOLDER` bucket keys off `destinationDirectoryMissing === true`
   and therefore degrades to "straightforward" for families that never set it,
   rather than mis-bucketing them.

Still unproven: `delete` and `plex_sync` (verification against an external
system rather than local state).

## Reversibility is engine truth, not a UI guess

Auditing the surface for the `delete` case exposed something worse than a UI
assumption: `reversible: boolean` was itself dishonest. `rename` reverts by
moving the file back, and that revert **throws** when something else has taken
the original path. The engine was claiming an unconditional undo it could not
guarantee, and the review surface was separately inferring `canRevert` from
`status === 'completed'` — so two layers were independently guessing.

There are three kinds, and the middle one is the reason a boolean failed:

| Kind | Meaning | Families |
| --- | --- | --- |
| `reversible` | prior state restored exactly from recorded data | `reconcile`, `link`, `unlink`, `metadata_update` |
| `conditional` | restorable only while a stated condition holds | `rename`, `move`, `import`, `restore`, `acquire` |
| `irreversible` | no automatic undo | `delete`, `plex_sync` |

`ActionHandler.reversibility` carries `{ kind, strategy, explanation,
conditions }`. Every proposal additionally reports `available`,
`revertableSteps` and `blockedReason`, computed in `store.ts` from real step
state. The distinction between *never applied* and *applied, then undone* is
deliberate: after a successful revert the engine must not say "nothing has been
applied yet", because something was.

The review surface now reads all of this instead of deriving any of it. It
shows the kind before approval — while the operator can still stop — and a
one-way action says so at the moment of commitment rather than being discovered
afterwards. A test asserts the confirm panel for an irreversible action never
contains an undo promise.

**Rule for the next family: the UI may not infer reversibility from the action
type or the proposal status. If the engine did not say it, the surface does not
claim it.**