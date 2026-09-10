---
name: Canonical acquisition lifecycle
description: Durable provider-backed acquisition tracking above the existing filesystem download engine.
---

Archive Assistant uses a separate canonical acquisition job for provider requests. It owns planned/searching/source-selected/downloading/processing/verifying/importing/complete/failed/cancelled state, provider references, phase timestamps, and transition events.

**Why:** External providers can discover and download media without becoming the source of truth for archive identity or local filesystem state. Keeping this lifecycle separate prevents provider polling from silently mutating files or bypassing the existing download engine.

**How to apply:** Route control-plane acquisition work through the acquisition-job service and integration registry. Treat provider refreshes as evidence for progression, preserve explicit failed/cancelled states, and require explicit progression for local processing/importing/completion.