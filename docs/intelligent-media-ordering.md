# Intelligent media ordering

Archive Assistant treats ordering as collection analysis, not as a blind batch rename.

## Current supported analysis

The ordering analyzer can produce a reversal proposal only when every participating item has:

- an explicit episode number;
- an explicit publication date;
- a monotonic conflict between current numbering and publication chronology.

Incomplete or conflicting evidence produces no action.

Filesystem modification time, title similarity, and filename proximity are not accepted as authoritative publication order.

## Safe rename planning

`buildCollisionSafeRenamePlan` produces a two-phase path plan. It first moves participating files to unique temporary sibling paths, then moves those temporary paths to their destinations. This supports swaps and larger permutations without naïve destination collisions.

The planner is read-only. It does not execute, approve, preflight, verify, or revert a filesystem operation. Execution must remain behind the existing archive-operation control plane.

## Current limitation

Collection-level API discovery, review UI, persistence of exact mappings, and archive-operation integration are not yet complete. No ordering analysis currently mutates files or creates an operation automatically. This limitation is intentional until collection membership and source publication metadata can be established from owner-scoped archive truth.
