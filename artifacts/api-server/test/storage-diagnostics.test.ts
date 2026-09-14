import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

// The packaged Windows install reported large live counts while the database
// at the expected location held 12 rows. These tests pin the behaviour the
// diagnostic must have for that comparison to be trustworthy: it must report
// the database the process actually opened, and it must say where that path
// came from.

test("databasePathSource distinguishes a configured path from the cwd fallback", async () => {
  const { databasePathSource } = await import("../src/services/storage-diagnostics");

  assert.equal(
    databasePathSource({ ARCHIVE_DB_PATH: "C:\\Users\\x\\AppData\\Local\\app\\a.sqlite" }),
    "ARCHIVE_DB_PATH",
  );

  // An unset variable falls back to `${cwd}/data/...`, which in a packaged
  // install depends on how the process was launched. That must be visible.
  assert.equal(databasePathSource({}), "working_directory_fallback");

  // An empty or whitespace-only value takes the same fallback branch inside
  // runtime-config, so it must be reported as the fallback, not as configured.
  assert.equal(databasePathSource({ ARCHIVE_DB_PATH: "" }), "working_directory_fallback");
  assert.equal(databasePathSource({ ARCHIVE_DB_PATH: "   " }), "working_directory_fallback");
});

test("readStorageDiagnostics reports the open database, its counts and Plex state", async () => {
  // runtime-config resolves the database path once at module load, so the
  // diagnostic must agree with the path this process was actually launched
  // with rather than with anything set afterwards. That is exactly the
  // property the packaged investigation depends on.
  const { archiveDb } = await import("../src/lib/archive-db");
  const { readStorageDiagnostics } = await import("../src/services/storage-diagnostics");

  const expectedPath = process.env.ARCHIVE_DB_PATH;
  assert.ok(expectedPath, "the harness must supply ARCHIVE_DB_PATH");

  const before = readStorageDiagnostics();

  assert.equal(before.databasePath, expectedPath);
  assert.equal(before.databasePathSource, "ARCHIVE_DB_PATH");
  assert.equal(before.databasePathIsAbsolute, true);
  assert.ok(existsSync(before.databasePath), "the reported database must exist on disk");
  assert.equal(typeof before.databaseSizeBytes, "number");

  // Counts must be read from this connection, so a write here must move them.
  const baselineFiles = before.counts.fileRecords;
  const baselineActive = before.counts.activeFileRecords;

  archiveDb
    .prepare(
      "INSERT INTO file_record (id, owner_id, path, filename, extension, size_bytes, scan_status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
    )
    .run(910001, "__local__", "/tmp/storage-diagnostics-a.mkv", "a.mkv", "mkv", 10);

  const afterInsert = readStorageDiagnostics();
  assert.equal(afterInsert.counts.fileRecords, baselineFiles + 1);
  assert.equal(afterInsert.counts.activeFileRecords, baselineActive + 1);

  // Plex configuration lives in the same database as the archive rows, so a
  // lost database loses the Plex connection too. Surface the state, never the
  // credential.
  archiveDb
    .prepare(
      "INSERT INTO setting (key, value, updated_at) VALUES ('plexToken', 'super-secret-token', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run();

  const afterPlex = readStorageDiagnostics();
  assert.equal(afterPlex.plexConfigured, true);
  assert.ok(
    !JSON.stringify(afterPlex).includes("super-secret-token"),
    "storage diagnostics must never expose credential values",
  );

  assert.ok(
    afterPlex.journalMode === null || typeof afterPlex.journalMode === "string",
    "journal mode must be reported so a WAL explanation can be tested, not assumed",
  );
});
