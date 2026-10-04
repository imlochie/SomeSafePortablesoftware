# Archive Assistant product gap map

**Audit basis:** release baseline `0aecd61` (Windows desktop baseline), inspected 2026-10-04. This is a product audit, not a claim that every proposed surface exists.

## 1. What the product already does well

### Implemented and trustworthy

- **Local-first control plane:** React/Vite calls the Express/Node engine; SQLite, credentials, filesystem paths, media tools, and provider adapters stay server-owned. Tauri is a sidecar shell rather than a second backend.
- **Real archive evidence:** archive roots can be scanned, file metadata and FFprobe results persist, integrity failures distinguish corrupt media from inspection/tooling failures, and Plex inventory can be reconciled without destroying the previous snapshot on remote failure.
- **Conservative identity and review:** local media identity, Plex matches, duplicate/quality findings, naming proposals, and uncertain matches are represented as reviewable evidence. Review decisions are owner-scoped and changed evidence can reopen a finding.
- **Approval boundary:** archive mutations have durable operations, preflight, explicit confirmation, retry/cancel/rollback paths, and audit history. Recommendations do not silently rename, move, delete, or import files.
- **Honest integration states:** disconnected/unconfigured Plex and acquisition providers are surfaced instead of being replaced with fabricated results. Secrets remain server-side.
- **Durable operational state:** downloads, processing, acquisition jobs, review items, system events, workload lineage, scan lifecycle, and settings are persisted and exposed through generated API contracts.
- **Windows release baseline:** bundled Node/media tooling, packaged API, SQLite persistence, installer smoke test, and production builds are already validated. This audit does not reopen packaging work.

## 2. What the current UI communicates poorly

- **The navigation names subsystems, not an operator journey.** HOME, ASSISTANT, QUEUE, ARCHIVE, PLEX, SOURCES, HISTORY, and SETTINGS are technically accurate but make the user assemble the relationship between observation, uncertainty, review, approval, and outcome.
- **Home mixes two competing readouts.** It combines system metrics, storage, recent events, workload, and assistant findings. The most important question—what needs a human decision next—is not consistently the first or only hierarchy.
- **Assistant is an operational control plane, not yet an assistant experience.** It has recommendations, reviews, providers, acquisitions, operations, and lineage, but a user must understand internal entities before knowing what is safe to do. The evidence model is present but buried in dense rows/details.
- **Archive is powerful but overloaded.** Browse inventory, local review, naming proposals, Plex-only media, missing media, scan status, bulk review, acquisition, and record detail share one large surface. This hides the difference between “known,” “matched,” “missing,” “uncertain,” and “actionable.”
- **Status vocabulary is inconsistent in meaning.** “Health,” “review,” “quality,” “integrity,” “blocked,” “waiting,” and “unresolved” appear in different surfaces without a shared explanation of whether they describe evidence, a decision, a job, or a provider condition.
- **Evidence is often available only after expansion or navigation.** The UI frequently shows a recommendation and next step before showing its source observations, freshness, confidence, and what is explicitly unknown.
- **The visual language is restrained and readable, but hierarchy is still card-led.** Several metrics and panels compete for attention. The next action and the consequence of that action need stronger typographic and structural priority than decorative status blocks.

## 3. Conceptually incomplete features

These are **partial**, even where backend support exists:

- **Assistant briefing:** backend `/api/assistant/overview` returns summary, groups, blocked/uncertain/informational items, active work, media experience, and evidence, but the primary landing experience does not yet make this a reliable “what matters / why / next” briefing.
- **Unified work model:** `/api/assistant/workload` and lineage exist, but navigation still exposes queue, acquisition, review, and operations as separate mental models. The user needs one decision-to-outcome journey with domain detail behind it.
- **Review workflow:** decisions, notes, bulk actions, and approval gates work, but the distinction between observation, recommendation, review decision, approval, confirmation, and result is not taught at the point of action.
- **Identity audit:** identity evidence and ambiguity are implemented in services/API, but the user-facing archive experience does not yet make match strength, candidate alternatives, and “what would change this conclusion?” first-class.
- **Naming intelligence:** proposals and controlled operations exist, but naming is a tab in Archive rather than an explainable review queue with collision/impact previews.
- **Acquisition intelligence:** recommendation generation and durable provider lifecycle exist, but “missing,” “higher quality,” “provider unavailable,” “approved,” “requested,” “downloaded,” and “imported” are not yet a single comprehensible flow.
- **Media experience:** provider-derived artwork, metadata, viewing context, research, and discovery are implemented in backend surfaces/components, but are not clearly connected to archive stewardship. This is a secondary product track, not a reason to mix media browsing into the control-room home.
- **Freshness and scope:** scan timestamp, provider sync status, stale data, and unavailable dependencies exist in data, but are not consistently displayed alongside conclusions.

## 4. Implemented but currently vague or untrustworthy-feeling

The system is not necessarily incorrect; the presentation makes it hard to trust:

- “Everything looks good” can be inferred from incomplete assistant data if the assistant query is deferred or unavailable. A missing readout must never look like a healthy archive.
- “Health” can mean storage/API/dependency health, archive media integrity, or review workload. These must be named as separate scopes.
- “Confidence” and “priority” are returned, but the UI does not consistently explain how they relate. Confidence is evidence strength; priority is operator urgency—not a probability or a quality score.
- Provider counts and “ready” states can be read as provider success rather than capability/status checks. The UI needs last verified time and explicit unavailable reasons.
- “Review” can mean a pending operator decision, a quality observation, or a generic review item. The state machine should be visible, especially before an action that may start provider work or mutate files.
- Empty states sometimes describe a reserved surface rather than telling the operator what data is missing, how to create it, and what will happen next.

## 5. Important backend concepts not surfaced properly

- Assistant overview groups and their `state`, `confidence`, `evidence[]`, `recommendedAction`, and `underlyingItemIds`.
- Summary freshness, `lastScan`, attention/blocked/uncertain counts, and severity breakdown.
- Explicit unknowns: blocked reasons, inspection unavailable vs corrupt, no-match vs ambiguous identity, provider unavailable, and stale inventory.
- Workload lineage across origin → review → approval → acquisition → download → verification → operation → outcome.
- Durable acquisition transition history and the fact that provider completion is not archive import completion.
- Archive operation preflight/postflight/rollback state and confirmation boundary.
- Evidence hashes/reopen semantics that explain why a previous decision may no longer apply.
- Identity audit candidates and match method, naming collision status, quality differences, and Plex reconciliation freshness.
- Media experience evidence and personal-context signals should be surfaced as evidence where relevant, not as unexplained personalization.

## 6. Redesign, do not merely restyle

1. **Information architecture:** introduce a small set of mental models—Briefing, Decide, Work, Archive, Connections, History, Settings—while keeping existing routes compatible during migration.
2. **Assistant/Home relationship:** make Home a read-only briefing and Assistant the decision workspace. Do not duplicate every admin control on both screens.
3. **Finding detail:** use a consistent evidence panel for every recommendation/finding: conclusion, evidence, confidence, freshness, uncertainty, next action, and consequence.
4. **Review/action flow:** make review decision → approval → preflight → confirmation → result explicit and chronological. Never collapse these into one optimistic button.
5. **Archive sections:** separate browse inventory from stewardship queues (identity, integrity, quality, naming, missing/acquisition) without removing the existing record detail and bulk workflows.
6. **State language:** define a shared state taxonomy and use it in labels, empty states, events, and tests.

## 7. Ideal information hierarchy

1. **Now:** the highest-priority operator decision, or a clearly scoped healthy/quiet state.
2. **Why:** the conclusion, urgency, evidence, confidence, and freshness.
3. **Uncertainty:** what is not known, blocked, stale, unavailable, or ambiguous.
4. **Next:** the smallest safe action and its expected consequence.
5. **Work:** active/queued/waiting operations and their lineage.
6. **Archive:** searchable records and stewardship queues.
7. **Connections and configuration:** providers, paths, tools, and settings.
8. **History:** durable facts about what changed and why.

Every important screen should expose the six questions: what is happening, why it matters, what is known, what is uncertain, what can I do, and what happens if I do it.

## 8. Primary user journey

A user should open Archive Assistant and see a calm, scoped briefing—not a dashboard of unrelated numbers:

1. **Observe:** “Two items need your attention; archive scan is from 2 hours ago; Plex was last verified yesterday.”
2. **Understand:** open one finding and see the conclusion, evidence, confidence, freshness, and explicit unknowns.
3. **Decide:** accept, reject, defer, or open the relevant record. If acquisition or a file operation is possible, show the policy boundary before proceeding.
4. **Approve and confirm:** review the planned operation and preflight, then explicitly confirm the irreversible step.
5. **Follow through:** see one lineage from recommendation to provider/download/import/verification/outcome.
6. **Learn:** history records what happened; the briefing updates only after persisted evidence changes.

## Practical next-phase architecture plan

### Slice 1 — Briefing truth (implemented in this change)

- **Existing support:** `GET /api/assistant/overview`, system overview, workload summary, freshness and evidence fields, generated client hook.
- **UI behavior:** Home requests the assistant overview on initial load, shows loading/unavailable distinctly, and only claims a healthy state after the assistant readout has loaded successfully. Preserve the current Assistant decision surface.
- **Tests:** contract/surface test protects against reintroducing a disabled assistant readout and against treating unavailable data as healthy.

### Slice 2 — Evidence-first finding detail (implemented in this change)

- **Backend:** added the read-only `GET /api/assistant/findings/{findingId}` model. It normalizes group/recommendation identity, state, priority, conclusion, evidence, confidence, freshness, uncertainty, blockers, consequence, and safe references. Evidence is labeled as coming from the assistant overview; unavailable timestamps and empty evidence remain explicit.
- **UI:** added the reusable `FindingDetail` evidence record and `/assistant/findings/:findingId` route. Home findings and Assistant recommendation evidence now open it instead of sending the operator directly to a generic subsystem.
- **Boundary:** this slice explains only. It does not approve, execute, rename, move, delete, import, or start provider work.
- **Tests:** generated contract alignment, API read-model behavior, evidence/state/uncertainty UI coverage, deep-link coverage, and release-check all pass.

### Slice 3 — Decision flow and lineage

- **Existing support:** review decisions, approval-bound acquisition, archive operations, preflight/execute/rollback, workload lineage.
- **Missing support:** a single read model joining recommendation/review/operation state and consequence text.
- **UI:** explicit stepper from observe through outcome; no action button without state, permission, and consequence copy.

### Slice 4 — Stewardship IA

- **Existing support:** archive browse, local review, integrity, quality, duplicates, naming, missing media, Plex-only projections, bulk review.
- **UI:** split Archive into Browse and Needs review with typed queues. Keep record detail and existing APIs; add filters/deep links before changing backend behavior.

### Slice 5 — Connections and freshness

- **Existing support:** integrations, Plex sync, dependency detection, settings, scan status.
- **Missing support:** common `lastVerifiedAt`/freshness semantics across provider and scan readouts.
- **UI:** Connections page that distinguishes configured, verified, stale, unavailable, and not configured.

### Slice 6 — Visual system and media experience

Only after the above models are working: reduce competing metric cards, establish typography for “conclusion/evidence/uncertainty/action,” then connect media artwork/context where it supports a stewardship decision. Avoid a cosmetic dashboard rewrite.

## Scope discipline

- **Implemented:** claims above refer to the inspected baseline and its APIs/services/tests.
- **Partial:** anything described as a gap or slice is not being treated as shipped behavior.
- **Proposed:** later slices are architecture/product direction only until implemented and tested.
- No AI provider, autonomous decision-making, automatic filesystem mutation, or fabricated provider data is introduced by this roadmap.
