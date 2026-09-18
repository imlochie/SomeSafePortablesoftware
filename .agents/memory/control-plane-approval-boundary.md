---
name: Control-plane approval boundary
description: Safety boundary between intelligence, operator decisions, acquisition jobs, and filesystem mutation.
---

Acquisition recommendations, naming proposals, and findings are evidence-bearing advisory records. Approval is explicit and durable, but approval alone starts neither provider work nor file mutation. Provider work requires a separate explicit start confirmation resolved from the approved owner-scoped recommendation. Filesystem changes require a separately planned operation, a successful current preflight, and explicit execution confirmation.

**Why:** Provider state, storage capacity, source paths, collisions, and review evidence can change between recommendation and execution. Keeping intelligence, approval, and execution separate prevents stale recommendations or background polling from changing the archive.

**Where it is enforced:** `assertAcquisitionApproval` in `services/acquisition-approval.ts` is the single gate for provider work, called from `startProvider` in `services/acquisition-jobs.ts`. Every path that contacts a provider — `createAcquisitionJob({ start: true })`, `retryAcquisitionJob`, and the orchestrated path from an approved recommendation — passes through it. The job carries its authorization in `metadata.reviewItemId` or `metadata.policyDecision.reviewItemId`; the gate re-reads the review item owner-scoped at start time, so an approval withdrawn after planning blocks the start. The call sits deliberately *outside* `startProvider`'s try block: a missing approval is a refusal to act, not a provider failure, so it must not be recorded as a failed attempt that retry would replay. Filesystem mutation has the equivalent gate inside `archive-operations.ts`.

**How to apply:** New assistant tools and automation may create or reconcile pending review items. They must never auto-approve. Clients must not supply trusted owner or approval metadata. Downstream provider and file actions must resolve persisted approval for the active owner, remain idempotently linked, and re-check applicable safety conditions immediately before execution.