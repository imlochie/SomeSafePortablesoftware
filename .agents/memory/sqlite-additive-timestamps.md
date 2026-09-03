---
name: SQLite additive timestamps
description: Migration rule for adding timestamp columns to populated local SQLite tables without data loss.
---

When adding a timestamp column to an existing SQLite table, use a constant migration-safe default, backfill existing rows with `CURRENT_TIMESTAMP`, and preserve insert-time timestamp behavior with a trigger or explicit inserts.

**Why:** SQLite rejects `ALTER TABLE ... ADD COLUMN` with a non-constant default such as `CURRENT_TIMESTAMP` when the table already contains rows. Fresh-database checks do not expose this failure.

**How to apply:** Exercise additive migrations against a pre-migration database containing rows; do not validate migration safety only by creating a blank database.