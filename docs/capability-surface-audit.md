# Capability Surface Audit

> Generated 2026-09-16, after the `reconcile` pass.
>
> The premise: a capability that exists only in the backend is **unfinished
> product surface**, however good its implementation. Pass 4 proved backend
> capability and product capability can diverge silently — the engine was
> universal while the review surface was still rename-shaped. This document
> looks for the same divergence everywhere else.

## Method

Three sources of evidence, not opinion:

1. All **84 operations** in `lib/api-spec/openapi.yaml`.
2. Every generated hook name referenced anywhere under
   `artifacts/archive-assistant/src` — an operation whose hook appears nowhere
   has no UI path to it, by construction.
3. The eight navigation destinations in `navItems` (`App.tsx:48`): HOME,
   ARCHIVE, PLEX, SOURCES, QUEUE, ASSISTANT, HISTORY, SETTINGS.

Reproduce with `scripts/audit-capability-surface.mjs`.

## The four levels

```text
VISIBLE         the user can see it
UNDERSTANDABLE  the user can see why it exists and what it knows
ACTIONABLE      the user can reach a safe operation from it
CLOSED LOOP     the result flows back into observation and history
```

Grades: 🟢 fully surfaced · 🟡 surfaced but awkward or disconnected ·
🟠 read-only where an action exists · 🔴 backend-only.

## Headline numbers

| | |
| --- | --- |
| Public API operations | 84 |
| Operations with no UI hook usage | **22 (26%)** |
| Navigation destinations | 8 |
| Action families wired end to end | 4 of 11 (`rename`, `move`, `import`, `reconcile`) |

## The matrix

| Capability | Backend | Visible | Understandable | Actionable | Closed loop | Grade |
| --- | --- | --- | --- | --- | --- | --- |
| Archive inventory | real | ARCHIVE | yes | yes | yes | 🟢 |
| Archive health | real | ARCHIVE | yes | partly | yes | 🟢 |
| Naming intelligence | real | ARCHIVE | yes | yes → proposal | yes | 🟢 |
| Action proposals / review | real | ARCHIVE | yes | yes | yes | 🟢 |
| Execution, verify, revert | real | proposal | yes | yes | yes | 🟢 |
| Reconcile (identity links) | real | ARCHIVE | yes | yes | yes | 🟢 |
| Download queue | real | QUEUE | yes | yes | yes | 🟢 |
| History / provenance | real | HISTORY | yes | read | yes | 🟢 |
| Plex inventory | real | PLEX | yes | read-only | partly | 🟠 |
| Assistant / AI tools | real | ASSISTANT | yes | yes | yes | 🟢 |
| Sources / integrations | real | SOURCES | yes | yes | yes | 🟢 |
| **Acquisition jobs** | **992 lines** | **none** | no | **no** | no | **🔴** |
| **Acquisition intelligence** | **434 lines** | lookup only | partly | **no** | no | **🔴** |
| **Identity audit** | real | **none** | no | no | no | **🔴** |
| **Reconciliation report** | real | only via proposal | partly | via reconcile | yes | 🟡 |
| **Action capabilities** | real | **none** | no | n/a | n/a | 🟠 |
| **Assistant tool catalog** | real | **none** | no | n/a | n/a | 🟠 |
| Review items | real | indirect | no | no | partly | 🟡 |
| Retry a proposal | real | **none** | no | **no** | n/a | 🔴 |
| Download event stream (SSE) | real | polling instead | n/a | n/a | n/a | 🟡 |

## The 22 unreachable operations

```text
ACQUISITION  (10)  the largest hole by far
  GET    /acquisition-jobs                      POST   /acquisition-jobs
  GET    /acquisition-jobs/{id}                 POST   /acquisition-jobs/{id}/cancel
  POST   /acquisition-jobs/{id}/download        POST   /acquisition-jobs/{id}/import
  POST   /acquisition-jobs/{id}/progress        POST   /acquisition-jobs/{id}/refresh
  POST   /acquisition-jobs/{id}/retry           GET    /acquisition-recommendations/{id}

IDENTITY / RECONCILIATION  (2)
  GET    /archive/identity-audit                GET    /archive/reconciliation

ACTION LAYER  (2)
  GET    /action-capabilities                   POST   /action-proposals/{id}/retry

REVIEW QUEUE  (2)
  POST   /review-items                          GET    /review-items/{id}

OTHER  (6)
  POST   /archive/acquisitions                  GET    /archive-operations/{id}
  GET    /assistant/tools                       GET    /downloads/events
  POST   /media/local-inspect                   POST   /acquisition-webhooks/{provider}
```

Not all of these are defects. Legitimately backend-only:

- `POST /acquisition-webhooks/{provider}` — a provider callback, not a user action.
- `GET /archive-operations/{id}` — the legacy compatibility adapter.
- `POST /media/local-inspect` — an internal probe the scanner uses.
- `GET /downloads/events` — an SSE transport the UI currently replaces with polling.

That leaves **18 operations representing real product capability with no door
into them.**

## The three findings that matter

### 1. Acquisition is the biggest hole in the product

1,557 lines of service code across `acquisition-jobs.ts` (992),
`acquisition-intelligence.ts` (434) and `acquisition-orchestration.ts` (131),
exposed through 10 endpoints, with a full job lifecycle — create, refresh,
progress, link a download, import, cancel, retry.

The UI reaches **one** of them. `ArchiveAcquisitionPanel` calls
`useLookupArchiveMedia` and nothing else: a user can search for media and can
never act on the result. There is no QUEUE-style surface for acquisition jobs,
no recommendation review, and `planApprovedAcquisitionImport` — which produces
an `import` action proposal, an already-wired action family — is unreachable.

This is the exact `REAL → INVISIBLE → UNACTIONABLE` pattern. It is also the
highest-leverage gap, because the action spine it would feed already works.

### 2. The identity graph has no home of its own

`reconciliation.ts` (411 lines) computes the unified picture — matched,
local_only, plex_only, duplicate, quality_conflict, uncertain — and
`/archive/identity-audit` grades identity coverage. Neither is rendered.

After the reconcile pass a user can *act* on unambiguous matches, but cannot
**see the world those matches came from**. Specifically there is nowhere to see:

- what is in Plex but not on disk, or on disk but not in Plex,
- the `uncertain` findings deliberately excluded from proposals,
- quality conflicts between two representations of the same episode.

This matters more than a missing page. The stated product model is that the
filesystem and Plex are *two observations of one media world*. Right now the
product can only show the moments where that world needs a mutation, never the
world itself. The `uncertain` exclusion was the right call, but it currently
means those findings vanish rather than surface as "I don't know, here's why."

### 3. The product cannot describe its own capabilities

`GET /action-capabilities` returns exactly what every family can do —
`supported`, `mutatesFiles`, `risk`, and now the full `reversibility` record.
Nothing renders it. Seven declared-but-unimplemented families are invisible
rather than honestly labelled "not yet available", which was the stated reason
for declaring them at all. `GET /assistant/tools` has the same problem.

## The rule this audit proposes

```text
Every real capability must have at least one   visible human entry point
Every mutable capability must have             a reviewable action path
Every completed action must have               an observable result
Every important result must have               history / provenance
```

"The AI tool can call it" does not satisfy the first line. AI is another
interface, not a substitute for discoverability. "There is an API route" does
not satisfy it either.

## Recommended order

1. **Acquisition surface** — the largest gap, and it terminates in `import`,
   an action family that already works end to end.
2. **Identity / media-world view** — makes the unified model visible, and gives
   `uncertain` findings somewhere to live instead of being silently dropped.
3. **Capability honesty** — render `/action-capabilities` so unimplemented
   families are visibly declared rather than absent.

Deliberately *not* first: more action families. Three of the four that exist
are the same filesystem primitive; the product's constraint is doors, not
engines.
