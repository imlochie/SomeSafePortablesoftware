---
name: SQLite upsert identity lookup
description: SQLite behavior to preserve when scans reconcile durable identity rows.
---

After an `INSERT ... ON CONFLICT DO UPDATE`, do not use `lastInsertRowid` as the row identifier. Query the canonical row by its owner-scoped unique key after the upsert.

**Why:** SQLite can leave `lastInsertRowid` pointing at an unrelated prior insert when the upsert takes the conflict/update path, which can attach later records to the wrong identity and silently break duplicate or quality comparisons.

**How to apply:** Use the unique owner/key pair to read the row id after any identity upsert, especially in archive scans and reconciliation code.