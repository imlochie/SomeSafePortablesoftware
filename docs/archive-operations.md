# Archive operations

## Batch filesystem foundation

Archive operations now carry an additive `batch_json` mapping payload while retaining the existing single-file fields for compatibility. A batch mapping records its stable id, original path, temporary sibling path, final path, and actual step state.

Batch execution uses two phases:

1. preflight every source, temporary path, destination, directory, duplicate mapping, and unrelated occupant;
2. move every source to its temporary sibling, then move every temporary path to its final destination.

Filesystem operations are not transactional. The guarantee is:

```text
all prevalidation before mutation
+ collision-safe staging
+ persisted planned/actual mapping state
+ verification
+ explicit recovery/revert
```

A preflight failure must not mutate any file. A failure after mutation begins is partial state, not an atomic failure.

The temporary-directory integration suite covers missing sources, unrelated destination occupants, a three-file cycle, exact revert, and preservation of unrelated files. The real configured archive is not used.

## Current boundary

Batch mappings are now accepted by the existing archive-operation creation service and are persisted in `batch_json`. The existing preflight, execution, and rollback entry points dispatch batch operations through the two-phase engine, preserving the same approval and owner-scoping boundary. Batch outcomes are persisted in the operation payload and operation events.

Ordering operations may now carry a `proposalId`. When present, creation loads the owner-scoped immutable proposal, requires its linked review item to be approved, derives the batch mapping server-side, and persists the proposal linkage. The execution path rechecks the proposal and approval before mutation. Batch step state is persisted after each temporary/final move where the database boundary succeeds; if that persistence boundary fails after a filesystem move, the operation is marked `recovery_required` rather than complete.

The proposal validator remains intentionally conservative: it does not invent publication chronology or use mtime/title heuristics. Review/workload UI integration and a richer current-archive identity comparison remain follow-up work. Existing single-file archive operation authorization, approval, preflight, verification, rollback, and owner isolation remain unchanged.
