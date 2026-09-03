---
name: Archive review identity
description: How non-destructive archive review decisions remain valid across scans.
---

Archive review decisions must be keyed by authenticated owner, file record, finding type, and a deterministic evidence identity. Do not store review state as a mutable flag directly on the file.

**Why:** An unchanged duplicate or quality finding should remain reviewed after another scan, while a changed checksum, media fingerprint, comparison, counterpart, or Plex match must reopen it without deleting the prior audit record.

**How to apply:** Any future archive intelligence that changes what constitutes a finding must update the evidence identity inputs in lockstep. Filesystem actions remain separate and must never be implied by review status.