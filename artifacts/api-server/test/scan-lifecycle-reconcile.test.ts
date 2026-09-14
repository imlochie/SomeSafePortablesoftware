import assert from "node:assert/strict";
import test from "node:test";

/**
 * Startup reconciliation of interrupted scans.
 *
 * A process that dies mid-scan leaves `archive_scan.status = 'scanning'`
 * behind. Nothing used to correct it, so the REST view reported a running scan
 * forever while the in-memory live feed -- which cannot survive a restart --
 * correctly reported idle. That contradiction also locked the operator out:
 * `startArchiveScan` returns early while the status is `scanning`.
 *
 * These tests reproduce that exact state and pin the reconciliation contract.
 */

const OWNER = "__local__";

test("an interrupted scan is closed out at startup without losing evidence", async () => {
  const { archiveDb } = await import("../src/lib/archive-db");
  const { reconcileInterruptedScans, readArchiveScan } = await import("../src/services/archive");

  // Reproduce a scan that died mid-flight: status still 'scanning', with real
  // progress and real failures already recorded.
  archiveDb
    .prepare(
      `INSERT INTO archive_scan (owner_id, status, started_at, completed_at, last_error, scanned_files, active_files, failed_files)
       VALUES (?, 'scanning', '2026-09-14T01:00:00Z', NULL, NULL, 431, 428, 3)
       ON CONFLICT(owner_id) DO UPDATE SET status = 'scanning', started_at = '2026-09-14T01:00:00Z',
         completed_at = NULL, last_error = NULL, scanned_files = 431, active_files = 428, failed_files = 3`,
    )
    .run(OWNER);

  const before = readArchiveScan(OWNER);
  assert.equal(before.status, "scanning", "precondition: the dead scan still claims to be running");

  const count = reconcileInterruptedScans();
  assert.equal(count, 1);

  const after = readArchiveScan(OWNER);

  // The lifecycle status must no longer claim to be running.
  assert.notEqual(after.status, "scanning");
  assert.equal(after.status, "failed");
  assert.ok(after.completedAt, "a terminal state must record when it was closed out");

  // The reason must be stated, not left null for the operator to guess at.
  assert.match(String(after.lastError), /interrupted/i);

  // Evidence the dead scan really did gather must be preserved exactly.
  // Discarding it would destroy the only record of the 3 failures it found.
  assert.equal(after.scannedFiles, 431);
  assert.equal(after.failedFiles, 3);
  assert.equal(after.activeFiles, 428);
});

test("reconciliation unblocks starting a new scan", async () => {
  const { archiveDb } = await import("../src/lib/archive-db");
  const { reconcileInterruptedScans, readArchiveScan } = await import("../src/services/archive");

  archiveDb
    .prepare(
      `INSERT INTO archive_scan (owner_id, status, started_at) VALUES (?, 'scanning', '2026-09-14T01:00:00Z')
       ON CONFLICT(owner_id) DO UPDATE SET status = 'scanning', completed_at = NULL, last_error = NULL`,
    )
    .run(OWNER);

  // `startArchiveScan` returns early while the status is 'scanning', so the
  // stale record is what locks the operator out. After reconciliation the
  // status is terminal and that early return no longer applies.
  reconcileInterruptedScans();
  assert.notEqual(readArchiveScan(OWNER).status, "scanning");
});

test("reconciliation leaves scans that already reached a terminal state alone", async () => {
  const { archiveDb } = await import("../src/lib/archive-db");
  const { reconcileInterruptedScans, readArchiveScan } = await import("../src/services/archive");

  archiveDb
    .prepare(
      `INSERT INTO archive_scan (owner_id, status, completed_at, last_error, scanned_files)
       VALUES (?, 'completed', '2026-09-14T02:00:00Z', NULL, 900)
       ON CONFLICT(owner_id) DO UPDATE SET status = 'completed', completed_at = '2026-09-14T02:00:00Z',
         last_error = NULL, scanned_files = 900`,
    )
    .run(OWNER);

  const count = reconcileInterruptedScans();
  assert.equal(count, 0, "a completed scan is not interrupted and must not be rewritten");

  const after = readArchiveScan(OWNER);
  assert.equal(after.status, "completed");
  assert.equal(after.lastError, null, "a clean completion must not gain a spurious error");
  assert.equal(after.scannedFiles, 900);
});

test("reconciliation is idempotent across repeated restarts", async () => {
  const { archiveDb } = await import("../src/lib/archive-db");
  const { reconcileInterruptedScans, readArchiveScan } = await import("../src/services/archive");

  archiveDb
    .prepare(
      `INSERT INTO archive_scan (owner_id, status) VALUES (?, 'scanning')
       ON CONFLICT(owner_id) DO UPDATE SET status = 'scanning', completed_at = NULL, last_error = NULL`,
    )
    .run(OWNER);

  assert.equal(reconcileInterruptedScans(), 1);
  const first = readArchiveScan(OWNER);

  // A second startup must find nothing to do and must not disturb the record.
  assert.equal(reconcileInterruptedScans(), 0);
  const second = readArchiveScan(OWNER);

  assert.equal(second.status, first.status);
  assert.equal(second.completedAt, first.completedAt);
  assert.equal(second.lastError, first.lastError);
});
