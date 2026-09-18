# Workload lineage

Archive Assistant exposes lineage as a read-only projection over existing domain records. It does not create a universal lifecycle entity or replace any persisted state machine.

## Sources of truth

The projection can connect existing records by explicit identifiers:

```text
acquisition recommendation
  → review item
  → acquisition job
  → download job
  → archive operation
```

The relationships are authoritative only where the persisted record contains the corresponding reference. Title, timestamp, provider, or filename similarity is never used to manufacture a relationship.

## Read-only APIs

```text
GET /api/assistant/workload
GET /api/assistant/workload/:workloadId/lineage
```

The workload endpoint provides compact stable references. The lineage endpoint expands one item into its supported stages.

## Stage status

Every stage is explicitly one of:

```text
known
unknown
not_applicable
```

`unknown` means a relationship or outcome cannot be established from persisted truth. `not_applicable` means the stage does not apply yet or no prior stage makes it applicable. Neither state is treated as success.

The projection distinguishes:

- a completed download from a completed archive operation;
- passed download verification from an archive postflight result;
- an approved review from an acquisition job;
- a failed download from a successful archive outcome.

## Safety boundary

Lineage reads do not execute acquisition, mutate providers, change approvals, mutate archive files, run preflight, or infer verification. A missing event or relationship remains unknown.

## Current truth and freshness

Workload items carry a read-only confirmation timestamp and freshness classification:

```text
fresh  → confirmed within 1 minute
recent → confirmed within 5 minutes
stale  → older than 5 minutes
unknown → no usable confirmation timestamp
```

These thresholds are deterministic presentation guidance, not lifecycle semantics. Stale never becomes failed or completed, and freshness never changes persisted state. Events only trigger a fresh read of authoritative records.

## Cross-surface journey

A workload item can be opened directly at:

```text
/workload/:workloadId
```

Home, Assistant, Queue, and History use the same domain-derived identity where it exists. The full-story page is a continuity surface, not a replacement for the Assistant explanation, Queue controls, or History audit record. Context is preserved through a small `from` hint so back navigation returns to the surface that opened the story.

The page currently presents a stage summary rather than reconstructing a complete event timeline. An event is not shown merely because two records have similar timestamps or titles.

## Naming and ordering analysis boundary

The repository now has a pure ordering-analysis primitive for future collection review. It only proposes a reversal when every participating item has explicit episode numbers and explicit publication dates with a monotonic conflict. Filesystem modification time, title similarity, and filename proximity are not accepted as publication chronology.

Conflicting or incomplete signals produce `no_action`. This analysis does not rename files, create review decisions, or mutate the archive.

## Current limitation

The existing schema does not persist one universal identifier across every domain boundary. Supported lineage follows the explicit references already present. Where no reference exists, the UI says that the journey cannot be confirmed rather than linking records heuristically.
