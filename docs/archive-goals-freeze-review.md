# ARCHIVE ASSISTANT goal review

Reviewed against the repository on September 11, 2026.

## Decision

The original Phase 1 mission is complete, and the later archive control-plane
refinements are substantially complete. The product is freeze-ready as a
local-first control plane, not as a finished autonomous assistant or a
self-contained Windows installer.

The freeze preserves these boundaries:

- The React UI calls the existing Express/Node engine; it does not access
  SQLite, provider credentials, media tools, or archive files directly.
- SQLite remains the local source of truth. External media services are
  replaceable providers, not a second control plane.
- The server resolves the owner. Local mode uses the stable `__local__` owner,
  while hosted Clerk mode retains per-user isolation.
- Recommendations and review findings are advisory. Archive file mutations
  require an approved operation and explicit confirmation.
- Provider status and failures are reported honestly. A disconnected provider
  is not replaced with fabricated data.
- Tauri is a shell around the Node engine. Moving media logic into Rust or the
  browser is outside the accepted architecture.
- `lib/api-spec/openapi.yaml` is the intended source for generated browser
  contracts; runtime-only routes are contract drift, not an alternate API.

## Original Phase 1 goals

The original goals are in
`attached_assets/Pasted-Build-a-Windows-first-local-application-called-ARCHIVE-_1788245046581.txt`.

| Goal | Classification | Shipped evidence or disposition |
| --- | --- | --- |
| Windows-first, local-first personal media archive control system | Complete | Windows launch scripts, local API mode, SQLite persistence, and configurable local paths are documented in `README.md`. |
| React/Vite interface with a Node/Express local engine | Complete | The UI and API remain separate workspace artifacts with the API owning local capabilities. |
| Local SQLite foundation without a required hosted database | Complete | The API uses embedded `node:sqlite`; `ARCHIVE_DB_PATH` is configurable. |
| HOME, ASSISTANT, QUEUE, ARCHIVE, PLEX, SOURCES, HISTORY, and SETTINGS shell | Complete | The application navigation and operational views are present in `artifacts/archive-assistant/src/App.tsx`. |
| Persistent settings, system health, local logging, mock mode, and dependency detection | Complete | Settings and diagnostics are server-owned and persisted; optional tools are detected without accepting arbitrary shell input. |
| Schema foundations for media, archive items, files, jobs, queue, conversations, events, and settings | Complete | The local database has evolved additively from the Phase 1 foundation. |
| Modular provider and media-tool seams | Complete | Provider access goes through capability adapters and the local download/processing engine remains separate from provider acquisition jobs. |
| Honest implemented/placeholder/disconnected states | Complete | Provider registry calls fail explicitly when unavailable; the UI does not invent external results. |
| Secrets remain server-side | Complete | Plex and provider credentials are not returned in browser-facing status responses. |
| No arbitrary AI shell execution | Complete | Tool execution is constrained to server-owned operations and configured executables. |
| Filesystem access only through configured archive paths | Complete | Archive operations validate managed paths before acting. |
| Local or OpenAI assistant responses | Intentionally deferred | The freeze is an archive control plane. A production AI conversation provider is not required for this boundary. |
| Ollama/local-model management | Intentionally deferred | No local-model runtime is required to validate archive inventory, review, acquisition, or operations. |

## Later media and archive goals

The later phase prompts and archive refinements expanded the original shell.
They did not replace the local engine or approval boundary.

| Goal | Classification | Shipped evidence or disposition |
| --- | --- | --- |
| Extract real media metadata with configured yt-dlp/FFmpeg/FFprobe tools | Complete | Tool paths are configurable and media extraction/processing stays in the API engine. |
| Persistent download and processing jobs | Complete | Local download jobs, processing state, events, and acquisition jobs are durable and separate. |
| Plex configuration, synchronization, and inventory reconciliation | Complete | Plex is a real adapter with server-side credentials, owner-scoped inventory, and reconciliation services. Artwork and hierarchy are a known UX follow-up, not a missing boundary. |
| Scan configured archive roots and persist real file metadata | Complete | Archive scanning is server-side, owner-scoped, incremental, and backed by persisted evidence. |
| Identify titles conservatively and send uncertain matches to review | Complete | Review state follows owner-scoped evidence; changed evidence reopens a finding. |
| Explain duplicate and quality findings with evidence | Complete | Archive intelligence exposes reasons and source evidence rather than an opaque score. |
| Compare Plex inventory with local archive inventory | Complete | Reconciliation and missing-media capabilities use the shared archive identity model. |
| Naming proposals without automatic renames | Complete | Proposals remain advisory until an approved and confirmed archive operation is executed. |
| Controlled archive delete, rename, move, and related mutations | Complete | `archive-operations.ts` enforces review approval, confirmation, owner scope, managed paths, and durable outcomes. |
| Provider-backed acquisition lifecycle above the local download engine | Complete | Acquisition orchestration persists provider references and transitions without pretending provider completion equals archive import completion. |
| Archive recommendations and review synchronization | Complete | `acquisition-intelligence.ts` and `review-sync.ts` preserve evidence and review context without autonomous mutations. |
| Local single-user mode plus retained Clerk multi-user mode | Complete | Identity is resolved server-side as `__local__` or the authenticated Clerk user; existing owned data is not silently reassigned. |
| Tauri shell that starts and monitors the Node API | Complete as an architecture boundary | `src-tauri` launches the API bundle and points the UI at its health-checked port. |
| Self-contained Windows desktop packaging | Intentionally deferred | The current shell depends on an installed Node runtime or `ARCHIVE_NODE_PATH`; bundling a runtime, installer diagnostics, and Windows path hardening are separate release work. |
| Autonomous AI decisions or archive changes | No longer applicable | Later requirements deliberately replaced autonomy with evidence, review, approval, and confirmation. |
| Automatic duplicate deletion, replacement, or reorganization | No longer applicable | These conflict with the accepted approval boundary. Findings may recommend; only confirmed operations mutate files. |
| Filename-only identity matching | No longer applicable | Identity is evidence-based and uncertain results require review. |
| Opaque “best quality” scores | No longer applicable | Quality comparisons must expose the contributing evidence. |
| A second hosted backend or database for local operation | No longer applicable | The accepted product keeps the existing Node engine and SQLite source of truth. |

## Boundary checks

### Architecture and ownership

Protected `/api` routes run behind server-side identity resolution. Local mode
retains the same owner filters using `__local__`; hosted mode uses Clerk user
IDs. Archive, Plex, download, review, event, and acquisition data must continue
to be queried and mutated by owner.

Provider webhooks are a separate unauthenticated ingress boundary. They may
resolve an owner only by an exact stored provider job/reference match and must
never accept an owner supplied by the request body. Existing owner-isolation
and hosted-audit follow-ups remain release-sensitive.

### Approval requirements

Archive filesystem operations satisfy the accepted boundary: a recommendation
does not mutate a file, approval alone does not mutate a file, and execution
requires confirmation.

`POST /archive/acquisitions` is not equivalent to a filesystem mutation, but it
currently starts provider work immediately. Its contract calls it a “request”
and accepts optional policy metadata without proving an approved review or an
explicit operator confirmation. Before this endpoint is presented as an
approved archive action, its owner must either:

1. require and validate an approved owner-scoped review decision plus explicit
   confirmation, or
2. rename and document it as an immediate provider request with authorization
   enforced in the UI and API contract.

### Provider honesty

Adapters check operational status before invocation and return explicit
unavailable errors. Acquisition jobs retain provider identity and transition
history, and local processing/import completion is not inferred from provider
completion.

Webhook audit classification still needs to distinguish ignored events from
successfully processed events. The existing webhook correctness, timeline,
privacy, replay, retention, and pagination tasks own that work.

### Desktop sidecar

The source validates the intended UI → Tauri shell → Node API boundary. It is
not yet a self-contained Windows distribution:

- Node is discovered from the host rather than bundled.
- default `~/ARCHIVE/...` values need Windows-safe home expansion;
- reserving a free port before the child binds leaves a startup race; and
- discarded child output limits launch diagnostics.

These are intentionally deferred packaging requirements. They do not justify
moving API, database, provider, or media-tool responsibilities into Tauri.

### Generated API contracts

The OpenAPI document contains archive scan, review, operation, lookup, missing
media, and acquisition surfaces. The generated client must be regenerated and
checked whenever that document changes.

There is current runtime/spec drift:

- inbound `/api/acquisition-webhooks/{provider}` is not in OpenAPI;
- archive reconciliation, naming-proposal, and identity-audit routes are not
  in OpenAPI; and
- generated browser output does not expose all archive lookup, missing-media,
  and acquisition operations already present in the specification.

A passing workspace type check does not prove route/spec/generated-client
parity. The API contract owner must inventory runtime routes, classify internal
routes explicitly, add every public route to OpenAPI, regenerate the client,
and add a parity check to release validation.

## Concrete remaining work

Existing project tasks already own the following gaps and should not be
replaced by broader roadmap items:

- Plex artwork and hierarchical browsing.
- Multi-finding review context and archive mutation error announcements.
- Dependency-check error reporting.
- Acquisition endpoint owner-isolation and archive request regression tests.
- Monotonic acquisition transitions, provider progress, and transition-history
  visibility.
- Webhook counting, redacted history, hosted privacy, retention, and pagination.
- Reliable API type checks.

The review identifies three additional, bounded follow-ups:

1. **Contract owner:** reconcile public Express routes, OpenAPI, and generated
   clients; add a release check that detects drift.
2. **Archive acquisition owner:** make immediate provider-start semantics
   explicit, or enforce approved owner-scoped review plus confirmation before
   starting provider work.
3. **Desktop release owner:** package a Windows-safe Node sidecar, normalize
   default paths, remove the port reservation race, and retain redacted launch
   diagnostics.

The stale product-status sections in `README.md` and `replit.md` were corrected
as part of this review. That drift was documentation-only, not a product
architecture change.

## Freeze classification

- **Complete:** original Phase 1 shell and local engine; archive inventory and
  intelligence; owner-scoped review; confirmed archive operations; Plex and
  provider capability boundaries; durable acquisition lifecycle; local/hosted
  identity modes; generated-contract architecture.
- **Intentionally deferred:** production AI providers and local models,
  autonomous assistant behavior, and a self-contained Windows desktop package.
- **No longer applicable:** autonomous or automatic archive mutation,
  filename-only identity, opaque quality scoring, and a second hosted control
  plane for local use.

The product can freeze on these classifications. Hosted release and broader
operator rollout remain conditional on the existing security, state-integrity,
webhook, and type-check tasks plus the bounded contract and acquisition-policy
follow-ups above.