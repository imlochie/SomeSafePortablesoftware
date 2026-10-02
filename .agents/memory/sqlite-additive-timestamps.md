---
name: SQLite additive timestamps
description: Migration rule for adding timestamp columns to populated local SQLite tables without data loss.
---

When adding a timestamp column to an existing SQLite table, use a constant migration-safe default, backfill existing rows with `CURRENT_TIMESTAMP`, and preserve insert-time timestamp behavior with a trigger or explicit inserts.

**Why:** SQLite rejects `ALTER TABLE ... ADD COLUMN` with a non-constant default such as `CURRENT_TIMESTAMP` when the table already contains rows. Fresh-database checks do not expose this failure.

**How to apply:** Exercise additive migrations against a pre-migration database containing rows; do not validate migration safety only by creating a blank database.

Every column added to a shipped table needs a matching additive `ensureColumn` migration, and the migration must be exercised against a legacy-shaped table, not just a fresh database.

**Why:** `archive-operations.ts` runs `reconcileInterruptedArchiveOperations()` at module scope, and an installed build crashed at API startup with `no such column: error_code` against a database that predated the column — the `CREATE TABLE IF NOT EXISTS` schema only helps databases that never had the table. The api-server test fixture never created `archive_operation` at all, so production init always created it fresh and the gap was invisible to all 268 tests.

**How to apply:** Plant a legacy-shaped `archive_operation` (birth columns only, no later columns) in `test-runner.mjs` so every test process imports through the additive migration, and extend the `archiveOperationColumns` sweep in `archive-db.ts` — never a single-column patch, because a database old enough to miss one column usually misses several. Verify negative coverage by temporarily disabling the sweep: the suite must then fail with the same `no such column` error as the installed app.