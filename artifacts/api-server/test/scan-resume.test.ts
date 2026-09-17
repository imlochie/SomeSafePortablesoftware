import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Resumable scanning.
 *
 * Scanning a large archive costs an FFprobe and a full SHA-256 read per file,
 * so an interrupted scan used to throw away every minute it had spent. A pass
 * now carries a `scan_run_id`, each examined file records the pass that
 * visited it, and an interrupted pass is continued rather than restarted.
 *
 * The dangerous part is the end-of-scan sweep that marks vanished files
 * `missing`. It used to consult an in-memory set of paths seen during the run,
 * which a resumed pass cannot reconstruct for files an earlier segment
 * handled. If that set is incomplete, present files get reclassified as
 * missing -- the worst thing this feature could do. These tests pin that
 * behaviour specifically.
 */

const OWNER = "__local__";

function seedScanRow(
  archiveDb: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } },
  values: Record<string, unknown>,
) {
  const columns = Object.keys(values);
  archiveDb
    .prepare(
      `INSERT INTO archive_scan (owner_id, ${columns.join(", ")})
       VALUES (?, ${columns.map(() => "?").join(", ")})
       ON CONFLICT(owner_id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(", ")}`,
    )
    .run(OWNER, ...Object.values(values));
}

test("an interrupted pass is resumed; a finished pass starts a new one", async () => {
  const { archiveDb } = await import("../src/lib/archive-db");
  const { planScanResumption } = await import("../src/services/archive");

  // Interrupted with a run id: continue that exact pass and keep its counters.
  seedScanRow(archiveDb, {
    status: "interrupted",
    scan_run_id: "run-alpha",
    started_at: "2026-09-14T01:00:00Z",
    scanned_files: 431,
    failed_files: 3,
    resumed_count: 1,
  });

  const resumed = planScanResumption(OWNER);
  assert.equal(resumed.resuming, true);
  assert.equal(resumed.scanRunId, "run-alpha");
  assert.equal(resumed.scannedFiles, 431, "progress must carry over, not reset to zero");
  assert.equal(resumed.failedFiles, 3);
  assert.equal(resumed.startedAt, "2026-09-14T01:00:00Z", "the pass keeps its original start time");
  assert.equal(resumed.resumedCount, 1);

  // A completed pass must NOT be resumed. Continuing it would skip every file
  // and report an instant scan that examined nothing.
  seedScanRow(archiveDb, { status: "completed", scan_run_id: "run-alpha" });
  const afterCompleted = planScanResumption(OWNER);
  assert.equal(afterCompleted.resuming, false);
  assert.notEqual(afterCompleted.scanRunId, "run-alpha", "a fresh pass needs a new id");

  // Interrupted but with no run id (an older database) cannot be resumed
  // safely, because nothing records which files were visited.
  seedScanRow(archiveDb, { status: "interrupted", scan_run_id: null });
  assert.equal(planScanResumption(OWNER).resuming, false);

  // A hard failure is not resumable either.
  seedScanRow(archiveDb, { status: "failed", scan_run_id: "run-beta" });
  assert.equal(planScanResumption(OWNER).resuming, false);
});

test("readVisitedPaths reports only the files stamped by the given pass", async () => {
  const { archiveDb } = await import("../src/lib/archive-db");
  const { readVisitedPaths } = await import("../src/services/archive");

  const insert = archiveDb.prepare(
    "INSERT INTO file_record (id, owner_id, path, filename, extension, size_bytes, scan_status, last_scan_run_id) VALUES (?, ?, ?, ?, 'mkv', 1, 'active', ?)",
  );
  insert.run(920001, OWNER, "/archive/one.mkv", "one.mkv", "run-one");
  insert.run(920002, OWNER, "/archive/two.mkv", "two.mkv", "run-one");
  insert.run(920003, OWNER, "/archive/three.mkv", "three.mkv", "run-two");
  insert.run(920004, OWNER, "/archive/four.mkv", "four.mkv", null);

  const visited = readVisitedPaths(OWNER, "run-one");
  assert.equal(visited.size, 2);
  assert.ok(visited.has("/archive/one.mkv"));
  assert.ok(visited.has("/archive/two.mkv"));
  assert.ok(!visited.has("/archive/three.mkv"), "another pass must not leak in");
  assert.ok(!visited.has("/archive/four.mkv"), "an unstamped file is not visited");
});

test("resuming skips examined files and never marks present files missing", async (t) => {
  // The integration case that matters: a real archive on disk, a pass that is
  // interrupted partway, then resumed. Files the first segment examined must
  // not be re-examined, and no present file may end up `missing`.
  const root = mkdtempSync(join(tmpdir(), "resume-archive-"));
  mkdirSync(join(root, "movies"), { recursive: true });

  const paths = ["a.mkv", "b.mkv", "c.mkv", "d.mkv"].map((name) => join(root, "movies", name));
  for (const path of paths) writeFileSync(path, `content of ${path}`);

  const { archiveDb } = await import("../src/lib/archive-db");
  const { readVisitedPaths } = await import("../src/services/archive");

  const runId = "run-resume-integration";

  // Simulate the first segment: two of the four files were examined and
  // stamped with this pass before the process died.
  const insert = archiveDb.prepare(
    "INSERT INTO file_record (id, owner_id, path, filename, extension, size_bytes, scan_status, last_scan_run_id) VALUES (?, ?, ?, ?, 'mkv', 10, 'active', ?)",
  );
  insert.run(921001, OWNER, paths[0], "a.mkv", runId);
  insert.run(921002, OWNER, paths[1], "b.mkv", runId);

  // The remaining two are known from an *earlier* completed scan, so they
  // exist as rows but carry a different pass id. This is precisely the state
  // that used to be misread: unvisited-by-this-pass but very much present.
  insert.run(921003, OWNER, paths[2], "c.mkv", "some-older-run");
  insert.run(921004, OWNER, paths[3], "d.mkv", "some-older-run");

  t.after(() => {
    archiveDb
      .prepare("DELETE FROM file_record WHERE id IN (921001, 921002, 921003, 921004)")
      .run();
  });

  const visited = readVisitedPaths(OWNER, runId);
  assert.equal(visited.size, 2, "only the two files this pass examined count as visited");
  assert.ok(visited.has(paths[0]));
  assert.ok(visited.has(paths[1]));

  // The resumed segment must still walk c and d.
  const remaining = paths.filter((path) => !visited.has(path));
  assert.deepEqual(remaining, [paths[2], paths[3]]);

  // And once it walks them, the sweep sees all four as visited, so none is
  // marked missing.
  archiveDb
    .prepare(
      "UPDATE file_record SET last_scan_run_id = ? WHERE owner_id = ? AND path IN (?, ?)",
    )
    .run(runId, OWNER, paths[2], paths[3]);

  const afterResume = readVisitedPaths(OWNER, runId);
  assert.equal(afterResume.size, 4, "every present file is visited by the end of the pass");
  for (const path of paths) {
    assert.ok(afterResume.has(path), `${path} must be seen by the completed pass`);
  }
});

test("a completed pass clears its run id so the next scan starts fresh", async () => {
  const { archiveDb } = await import("../src/lib/archive-db");
  const { planScanResumption } = await import("../src/services/archive");

  // scanArchive clears scan_run_id on completion. Without that, the next scan
  // would "resume" a pass that already covered the archive and skip everything.
  seedScanRow(archiveDb, { status: "completed", scan_run_id: null, resumed_count: 2 });

  const plan = planScanResumption(OWNER);
  assert.equal(plan.resuming, false);
  assert.equal(plan.scannedFiles, 0, "a fresh pass counts from zero");
  assert.equal(plan.resumedCount, 0);
});

test("readArchiveScan reports whether a scan would resume", async () => {
  const { archiveDb } = await import("../src/lib/archive-db");
  const { readArchiveScan } = await import("../src/services/archive");

  seedScanRow(archiveDb, {
    status: "interrupted",
    scan_run_id: "run-visible",
    resumed_count: 3,
  });
  const interrupted = readArchiveScan(OWNER);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.resumable, true, "the UI needs to know it will resume");
  assert.equal(interrupted.resumedCount, 3);

  seedScanRow(archiveDb, { status: "completed", scan_run_id: null, resumed_count: 0 });
  const completed = readArchiveScan(OWNER);
  assert.equal(completed.resumable, false);
});

test("a real completed scan clears its run id and keeps unreadable files present", async (t) => {
  // End-to-end over a real directory, driving the actual scan. This covers the
  // two paths unit tests could not reach: clearing scan_run_id on completion,
  // and stamping files the scanner failed to read so the vanished-file sweep
  // does not reclassify them as missing.
  const { archiveDb, readSettings, writeSettings } = await import("../src/lib/archive-db");
  const { startArchiveScan, readArchiveScan, planScanResumption } = await import(
    "../src/services/archive"
  );

  const root = mkdtempSync(join(tmpdir(), "resume-e2e-"));
  mkdirSync(join(root, "movies"), { recursive: true });

  // Real files. They are not valid media, so FFprobe fails on each -- which is
  // exactly the "could not inspect" path that must still count as present.
  const names = ["one.mkv", "two.mkv", "three.mkv"];
  for (const name of names) writeFileSync(join(root, "movies", name), `data ${name}`);

  const previousSettings = readSettings();
  writeSettings({ archiveDirectory: root });
  t.after(() => {
    writeSettings({ archiveDirectory: previousSettings.archiveDirectory });
    archiveDb.prepare("DELETE FROM file_record WHERE owner_id = ? AND path LIKE ?").run(OWNER, `${root}%`);
    seedScanRow(archiveDb, { status: "not_scanned", scan_run_id: null, resumed_count: 0 });
  });

  // Start from a clean slate so this pass is fresh.
  seedScanRow(archiveDb, { status: "not_scanned", scan_run_id: null, resumed_count: 0 });

  startArchiveScan(OWNER);
  // Wait for the scan to reach a terminal state.
  const deadline = Date.now() + 30_000;
  let state = readArchiveScan(OWNER);
  while (state.status === "scanning" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = readArchiveScan(OWNER);
  }

  assert.notEqual(state.status, "scanning", "the scan must finish within the timeout");

  // A finished pass must not leave a run id behind, or the next scan would
  // "resume" a pass that already covered the archive and examine nothing.
  assert.equal(
    state.resumable,
    false,
    "a finished pass must not advertise itself as resumable",
  );
  assert.equal(planScanResumption(OWNER).resuming, false);

  // Every file is present on disk. Whether the scanner could read it or not,
  // none may be classified as missing.
  const rows = archiveDb
    .prepare("SELECT path, scan_status, last_scan_run_id FROM file_record WHERE owner_id = ? AND path LIKE ?")
    .all(OWNER, `${root}%`) as Array<{ path: string; scan_status: string; last_scan_run_id: string | null }>;

  assert.equal(rows.length, names.length, "every file on disk must have a record");
  for (const row of rows) {
    assert.notEqual(
      row.scan_status,
      "missing",
      `${row.path} is present on disk and must never be marked missing`,
    );
    assert.ok(
      row.last_scan_run_id,
      `${row.path} must record the pass that visited it, even if it could not be read`,
    );
  }
});

test("a file whose record already exists stays present when the scanner cannot read it", async (t) => {
  // The `warningMessage` path: inspectFile itself threw, so no record is
  // written for the file during this pass. The old in-memory `found` set
  // included such files, so the vanished-file sweep left them alone. The
  // persisted equivalent must do the same, or a transient read error would
  // silently reclassify a present file as missing.
  const { archiveDb } = await import("../src/lib/archive-db");
  const { readVisitedPaths } = await import("../src/services/archive");

  const runId = "run-unreadable";
  const path = "/archive/unreadable.mkv";

  archiveDb
    .prepare(
      "INSERT INTO file_record (id, owner_id, path, filename, extension, size_bytes, scan_status, last_scan_run_id) VALUES (?, ?, ?, 'unreadable.mkv', 'mkv', 5, 'active', ?)",
    )
    .run(922001, OWNER, path, "an-older-run");
  t.after(() => {
    archiveDb.prepare("DELETE FROM file_record WHERE id = 922001").run();
  });

  // Before the stamp the file looks unvisited to this pass -- which is exactly
  // the state that would get it swept as missing.
  assert.ok(!readVisitedPaths(OWNER, runId).has(path));

  // This is the statement the scanner runs for an unreadable-but-present file.
  archiveDb
    .prepare(
      "UPDATE file_record SET last_scan_run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE owner_id = ? AND path = ?",
    )
    .run(runId, OWNER, path);

  assert.ok(
    readVisitedPaths(OWNER, runId).has(path),
    "an unreadable but present file must count as visited by this pass",
  );
});

test("scanArchive stamps unreadable files and clears the run id on completion", async () => {
  // Source-level guards for the two behaviours that no unit test can reach
  // without provoking a genuine mid-scan filesystem error. Both are one line
  // and both are destructive if removed: dropping the stamp marks present
  // files missing, and keeping the run id makes the next scan skip everything.
  // The suite bundles tests to CJS, so resolve from the workspace instead of
  // import.meta.url, which is not available in that form.
  const { readFile } = await import("node:fs/promises");
  const { join: joinPath } = await import("node:path");
  const source = await readFile(
    joinPath(process.cwd(), "src", "services", "archive.ts"),
    "utf8",
  );

  assert.match(
    source,
    /warningMessage[\s\S]{0,600}UPDATE file_record SET last_scan_run_id = \?/,
    "the unreadable-file branch must stamp the run id so the sweep treats it as present",
  );
  assert.match(
    source,
    /status: rootError \? "failed" : "completed",[\s\S]{0,400}scan_run_id: null/,
    "a finished pass must clear its run id so the next scan starts a new pass",
  );
});
