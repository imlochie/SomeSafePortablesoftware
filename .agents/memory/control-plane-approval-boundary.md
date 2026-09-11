---
name: Control-plane approval boundary
description: Safety boundary between intelligence, operator decisions, acquisition jobs, and filesystem mutation.
---

Acquisition recommendations, naming proposals, and findings are evidence-bearing advisory records. Approval is explicit and durable, but approval alone starts neither provider work nor file mutation. Provider work requires a separate explicit start confirmation resolved from the approved owner-scoped recommendation. Filesystem changes require a separately planned operation, a successful current preflight, and explicit execution confirmation.

**Why:** Provider state, storage capacity, source paths, collisions, and review evidence can change between recommendation and execution. Keeping intelligence, approval, and execution separate prevents stale recommendations or background polling from changing the archive.

**How to apply:** New assistant tools and automation may create or reconcile pending review items. They must never auto-approve. Clients must not supply trusted owner or approval metadata. Downstream provider and file actions must resolve persisted approval for the active owner, remain idempotently linked, and re-check applicable safety conditions immediately before execution.