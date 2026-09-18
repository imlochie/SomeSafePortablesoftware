import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, test } from "node:test";
import { readWorkload } from "../src/services/workload";
import { readReconciliationReport } from "../src/services/reconciliation";

/**
 * The classifier is unit tested in finding-severity.test.ts. This file proves
 * the wiring: that syncControlPlaneReviewItems actually suppresses
 * informational findings instead of creating one review item per reviewable
 * record, which is what made the queue report tens of thousands of pending
 * decisions on a real archive.
 */

let reviewSync: typeof import("../src/services/review-sync");
let reviewQueue: typeof import("../src/services/review-queue");
let archiveDb: typeof import("../src/lib/archive-db").archiveDb;
let writeSettings: typeof import("../src/lib/archive-db").writeSettings;
let invalidate: typeof import("../src/services/archive").invalidateArchiveInventoryCache;
let root = "";

const ownerId = "severity-sync-owner";

before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "archive-severity-sync-"));
  ({ archiveDb, writeSettings } = await import("../src/lib/archive-db"));
  ({ invalidateArchiveInventoryCache: invalidate } = await import("../src/services/archive"));
  reviewSync = await import("../src/services/review-sync");
  reviewQueue = await import("../src/services/review-queue");
  writeSettings({
    dataDirectory: root,
    downloadDirectory: root,
    temporaryDirectory: root,
    archiveDirectory: root,
  });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function addFile(input: {
  id: number;
  filename: string;
  checksum: string | null;
  fingerprint?: string | null;
  scanStatus?: string;
  height?: number | null;
}) {
  archiveDb.prepare(`
    INSERT INTO file_record
      (id, owner_id, path, filename, relative_path, scan_status, media_type,
       size_bytes, checksum, fingerprint, extension, height, container)
    VALUES (?, ?, ?, ?, ?, ?, 'movie', 1000, ?, ?, 'mkv', ?, 'mkv')
  `).run(
    input.id,
    ownerId,
    `${root}/${input.filename}`,
    input.filename,
    input.filename,
    input.scanStatus ?? "active",
    input.checksum,
    input.fingerprint ?? null,
    input.height ?? 1080,
  );
}

describe("review sync severity gating", { concurrency: false }, () => {
  test("informational findings do not become review items", async () => {
    // Two files with an identical checksum: a certain duplicate, and a real
    // decision. Two more sharing only a fingerprint: probable, not certain, so
    // an observation that must be suppressed.
    //
    // A local_only record would not exercise the gate at all: archive.ts marks
    // it not_applicable, so sync skips it before classification.
    addFile({ id: 9001, filename: "Certain Duplicate A.mkv", checksum: "identical-checksum" });
    addFile({ id: 9002, filename: "Certain Duplicate B.mkv", checksum: "identical-checksum" });
    addFile({ id: 9003, filename: "Probable Duplicate A.mkv", checksum: "different-a", fingerprint: "shared-fingerprint" });
    addFile({ id: 9004, filename: "Probable Duplicate B.mkv", checksum: "different-b", fingerprint: "shared-fingerprint" });
    invalidate(ownerId);

    const result = await reviewSync.syncControlPlaneReviewItems(ownerId);

    // The breakdown must account for every finding examined, not only the
    // ones that became review items.
    assert.equal(
      result.severity.total,
      result.archiveFindingItems + result.informationalFindings,
      "every classified finding is either a decision or an observation",
    );
    assert.equal(result.severity.reviewRequired, result.archiveFindingItems);
    assert.ok(result.informationalFindings > 0, "observations were suppressed");

    const items = reviewQueue.listReviewItems(ownerId, { kind: "archive_finding" });
    assert.equal(items.length, result.archiveFindingItems);

    // Nothing informational leaked into the queue.
    for (const item of items) {
      assert.notEqual(
        item.payload.severity,
        "info",
        `informational finding reached the queue: ${item.title}`,
      );
      assert.equal(item.payload.reviewRequired, undefined);
    }
  });

  test("review items carry their severity, confidence and reason", async () => {
    const items = reviewQueue.listReviewItems(ownerId, { kind: "archive_finding" });
    assert.ok(items.length > 0, "expected at least one decision");
    for (const item of items) {
      assert.ok(
        ["low", "medium", "high", "critical"].includes(String(item.payload.severity)),
        `unexpected severity ${String(item.payload.severity)}`,
      );
      assert.ok(String(item.payload.confidence).length > 0);
      assert.ok(
        String(item.payload.severityReason).length > 0,
        "a finding must explain why it was escalated",
      );
    }
  });

  test("the exact duplicate pair is what reached the operator", async () => {
    const items = reviewQueue.listReviewItems(ownerId, { kind: "archive_finding" });
    const titles = items.map((item) => item.title).sort();
    assert.deepEqual(titles, [
      "Review Certain Duplicate A.mkv",
      "Review Certain Duplicate B.mkv",
    ]);
    for (const item of items) {
      assert.equal(item.payload.severity, "medium");
      assert.equal(item.payload.confidence, "certain");
    }
  });

  test("syncing again is idempotent and does not multiply items", async () => {
    const before = reviewQueue.listReviewItems(ownerId, { kind: "archive_finding" }).length;
    invalidate(ownerId);
    await reviewSync.syncControlPlaneReviewItems(ownerId);
    const after = reviewQueue.listReviewItems(ownerId, { kind: "archive_finding" }).length;
    assert.equal(after, before);
  });

  test("provider-only reconciliation becomes a workload review item", async () => {
    const library = archiveDb.prepare(`
      INSERT INTO plex_library (name, server_url, library_key, library_type, owner_id, sync_status)
      VALUES ('Movies', 'http://plex.test', 'provider-only', 'movie', ?, 'synced')
    `).run(ownerId);
    archiveDb.prepare(`
      INSERT INTO plex_item (library_id, rating_key, title, item_type, year, metadata_json, owner_id)
      VALUES (?, 'provider-only-1', 'Unarchived Film', 'movie', 2025, '{}', ?)
    `).run(Number(library.lastInsertRowid), ownerId);
    invalidate(ownerId);
    const result = await reviewSync.syncControlPlaneReviewItems(ownerId);
    const item = reviewQueue.listReviewItems(ownerId, { kind: 'archive_finding' })
      .find((candidate) => candidate.payload.classification === 'plex_only');
    assert.ok(item, 'provider-only reconciliation must reach review');
    assert.equal(item?.payload.providerLabel, 'Plex');
    const workload = await readWorkload(ownerId);
    assert.ok(workload.items.some((work) => work.id === `review:${item?.id}`));
    assert.ok(workload.counts.needs_you > 0);

    archiveDb.prepare(`
      INSERT INTO file_record
        (path, size_bytes, checksum, owner_id, filename, relative_path, scan_status, archive_root)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run('/media/Unarchived Film.2025.mkv', 1000, 'provider-now-local', ownerId, 'Unarchived Film.2025.mkv', 'Unarchived Film.2025.mkv', '/media');
    invalidate(ownerId);
    await reviewSync.syncControlPlaneReviewItems(ownerId);
    const historical = reviewQueue.readReviewItem(item.id, ownerId);
    assert.equal(historical?.state, 'rejected');
    assert.equal(historical?.payload.lifecycleStatus, 'superseded');
    const reactivated = reviewQueue.ensureReviewItem(ownerId, {
      kind: 'archive_finding',
      subjectKey: item.subjectKey,
      title: item.title,
      payload: { classification: 'plex_only', evidenceKey: 'reactivated-evidence' },
    });
    assert.equal(reactivated.state, 'reopened');
    const updatedWorkload = await readWorkload(ownerId);
    assert.equal(updatedWorkload.items.filter((work) => work.id === `review:${item.id}`).length, 1);
    assert.ok(result.archiveFindingItems > 0);
  });

  test("a matched provider item does not create unnecessary workload attention", async () => {
    const owner = `matched-provider-owner-${Date.now()}`;
    const library = archiveDb.prepare(`
      INSERT INTO plex_library (name, server_url, library_key, library_type, owner_id, sync_status)
      VALUES ('Movies', 'http://plex.test', 'matched-provider', 'movie', ?, 'synced')
    `).run(owner);
    archiveDb.prepare(`
      INSERT INTO plex_item (library_id, rating_key, title, item_type, year, metadata_json, owner_id)
      VALUES (?, 'matched-1', 'Matched Film', 'movie', 2024, '{}', ?)
    `).run(Number(library.lastInsertRowid), owner);
    archiveDb.prepare(`
      INSERT INTO file_record
        (path, size_bytes, checksum, owner_id, filename, relative_path, scan_status, archive_root)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run('/media/Matched Film.2024.mkv', 1000, 'matched-checksum', owner, 'Matched Film.2024.mkv', 'Matched Film.2024.mkv', '/media');
    invalidate(owner);
    await reviewSync.syncControlPlaneReviewItems(owner);
    const reconciliation = await readReconciliationReport(owner, 1, 100);
    assert.equal(reconciliation.summary.matchedCount, 1);
    assert.equal(reconciliation.summary.qualityConflictCount, 0);
    const workload = await readWorkload(owner);
    assert.equal(workload.items.some((item) => item.title.includes('Matched Film')), false);
    assert.equal(workload.counts.needs_you, 0);
    await reviewSync.syncControlPlaneReviewItems(owner);
    const reviewCount = (archiveDb.prepare(
      "SELECT COUNT(*) AS count FROM review_item WHERE owner_id = ? AND kind = 'archive_finding'",
    ).get(owner) as { count: number }).count;
    assert.equal(reviewCount, 0);
  });

  test("ambiguous identity stays uncertain without creating workload", async () => {
    const owner = `ambiguous-provider-owner-${Date.now()}`;
    const library = archiveDb.prepare(`
      INSERT INTO plex_library (name, server_url, library_key, library_type, owner_id, sync_status)
      VALUES ('Movies', 'http://plex.test', 'ambiguous-provider', 'movie', ?, 'synced')
    `).run(owner);
    for (const ratingKey of ['ambiguous-1', 'ambiguous-2']) {
      archiveDb.prepare(`
        INSERT INTO plex_item (library_id, rating_key, title, item_type, year, metadata_json, owner_id)
        VALUES (?, ?, 'Same Film', 'movie', 2024, '{}', ?)
      `).run(Number(library.lastInsertRowid), ratingKey, owner);
    }
    archiveDb.prepare(`
      INSERT INTO file_record
        (path, size_bytes, checksum, owner_id, filename, relative_path, scan_status, archive_root)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run('/media/Same Film.2024.mkv', 1000, 'ambiguous-checksum', owner, 'Same Film.2024.mkv', 'Same Film.2024.mkv', '/media');
    invalidate(owner);
    const reconciliation = await readReconciliationReport(owner, 1, 100);
    assert.ok(reconciliation.results.some((result) => result.classification === 'uncertain'));
    await reviewSync.syncControlPlaneReviewItems(owner);
    const workload = await readWorkload(owner);
    assert.ok(workload.items.filter((item) => item.title.includes('Same Film')).length <= 1);
    await reviewSync.syncControlPlaneReviewItems(owner);
    const activeReviews = (archiveDb.prepare(
      "SELECT COUNT(*) AS count FROM review_item WHERE owner_id = ? AND state IN ('pending', 'reopened')",
    ).get(owner) as { count: number }).count;
    assert.ok(activeReviews <= 1, 'ambiguous identity must not multiply active review work');
  });

  test("a missing file escalates to a decision even with no other evidence", async () => {
    addFile({
      id: 9010,
      filename: "Vanished Recording.mkv",
      checksum: "vanished-checksum",
      scanStatus: "missing",
    });
    invalidate(ownerId);
    await reviewSync.syncControlPlaneReviewItems(ownerId);

    const missing = reviewQueue
      .listReviewItems(ownerId, { kind: "archive_finding" })
      .find((item) => item.title.includes("Vanished Recording"));
    assert.ok(missing, "a missing file must reach the operator");
    assert.ok(
      ["high", "critical"].includes(String(missing.payload.severity)),
      `expected an escalated severity, received ${String(missing.payload.severity)}`,
    );
  });
});
