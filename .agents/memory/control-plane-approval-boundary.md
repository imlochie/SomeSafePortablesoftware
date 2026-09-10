---
name: Control-plane approval boundary
description: Safety boundary between intelligence, operator decisions, acquisition jobs, and filesystem mutation.
---

Acquisition recommendations, naming proposals, and findings are evidence-bearing advisory records. Approval is explicit and durable, but approval alone does not mutate files. Filesystem changes require a separately planned operation, a successful current preflight, and explicit execution confirmation.

**Why:** Provider state, storage capacity, source paths, collisions, and review evidence can change between recommendation and execution. Keeping intelligence, approval, and execution separate prevents stale recommendations or background polling from changing the archive.

**How to apply:** New assistant tools and automation may create or reconcile pending review items. They must never auto-approve. Downstream actions must be owner-scoped and idempotently linked, and rename/move/import code must re-check approval and path safety immediately before execution.