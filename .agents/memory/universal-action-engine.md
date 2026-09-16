---
name: Universal Archive Action Engine
description: The single substrate every archive-mutating capability must use instead of inventing its own execution path.
---

Archive Assistant has one action substrate. Every capability that can change the
archive is expressed as an `ActionProposal` containing typed `ActionStep`s, and
the engine owns the whole lifecycle: propose → select → approve → preflight →
execute → verify → record → revert. Intelligence features answer only one
question — "what action can resolve this finding?" — and never implement
approval, mutation, verification, or rollback themselves.

**Why:** Intelligence grew faster than the action substrate, so each feature was
starting to invent its own proposal/approval/execution machinery. One engine
means one audit trail, one safety boundary, and one place to reason about
whether the product can actually change anything.

**How to apply:**

- Add a capability by registering an `ActionHandler` in
  `services/action-engine/registry.ts` with `preflight`, `execute`, `verify`,
  and `revert`. Do not add new execution paths elsewhere.
- Declared-but-unimplemented families must stay `supported: false` so the UI can
  report them honestly instead of failing at execution time.
- Proposals are inert. Creating one mutates nothing; approval alone mutates
  nothing. Execution requires an approved proposal, a current successful
  preflight, and explicit confirmation.
- Preflight re-derives `planHash`. If the plan changed after approval the
  proposal fails with `PLAN_CHANGED` rather than executing stale intent.
- Filesystem actions must stay inside configured Archive Assistant directories,
  refuse destination collisions (including two steps in one plan targeting the
  same path), and verify the destination after mutation.
- Batch proposals support per-step selection before approval; deselected steps
  become `skipped` and are never touched.
- `services/archive-operations.ts` is a compatibility adapter that maps the
  legacy single-operation contract onto the engine. Keep it thin; do not
  reintroduce execution logic there.
