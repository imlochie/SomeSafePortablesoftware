# Read-only control-plane audit

Date: 2026-09-19

The public read-only control plane is intentionally limited to current truth, bounded explanation, reconciliation, and provider observation provenance. It does not expose database tables or provider payloads.

| Concept | Public endpoint | OpenAPI | Generated client | Runtime response validation | Owner boundary |
| --- | --- | --- | --- | --- | --- |
| Assistant overview | `GET /assistant/overview` | yes | yes | yes | authenticated owner |
| Workload | `GET /assistant/workload` | yes | yes | yes | authenticated owner |
| Workload lineage | `GET /assistant/workload/{workloadId}/lineage` | yes | yes | yes | authenticated owner |
| Reconciliation report/summary | `GET /archive/reconciliation` | yes | yes | yes | authenticated owner |
| Finding lineage | `GET /archive/reconciliation/findings/{reviewItemId}/lineage` | yes | yes | yes | authenticated owner |
| Provider refresh state | `GET /provider/refresh?provider=...` | yes | yes | yes | authenticated owner |
| Provider refresh history | `GET /provider/refresh/history?...` | yes | yes | yes | authenticated owner |

## Vocabulary decisions

- `lastAttemptedRefresh` is the newest attempt regardless of outcome.
- `lastSuccessfulRefresh` is the newest complete successful observation.
- `currentAuthoritativeRefresh` is the refresh whose committed snapshot backs provider truth.
- `snapshotCompleteness` distinguishes complete, partial, and unknown observations.
- Finding lineage returns current and immediately previous observation context; the observation table remains the full-history owner.
- Workload contains references and bounded change context, not historical rows or provider payloads.

## Deliberately excluded

- provider credentials;
- SQLite/database access;
- complete provider response payloads;
- review-item observation table scans;
- operation execution or approval bypass;
- Arena-owned truth or review state.

## Verification

- OpenAPI/generated-client drift validation passes.
- HTTP integration coverage proves provider state/history pagination, invalid query handling, owner isolation, and finding lineage provenance.
- Backend suite passes with 268 tests.

The surface is frozen unless a concrete read-only consumer demonstrates a missing capability. New operations must be added contract-first with generated client output, runtime validation, and owner-isolation coverage.
