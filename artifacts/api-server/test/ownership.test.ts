import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { after, describe, test } from "node:test";
import {
  LEGACY_OWNER_ID,
  addEvent,
  archiveDb,
  claimLegacyData,
  legacyOwnedTables,
  readEvents,
  readSettings,
  readUserSetting,
  writeSettings,
  writeUserSetting,
} from "../src/lib/archive-db";
import {
  cancelJob,
  createJob,
  readJobs,
  subscribeDownloadEvents,
} from "../src/services/download-engine";
import {
  getPlexConfig,
  readPlexInventory,
  savePlexConfig,
  startPlexSync,
  syncPlexInventory,
  testPlexConnection,
} from "../src/services/plex";
import {
  readArchiveInventory,
  readArchiveScan,
  invalidateArchiveInventoryCache,
  startArchiveScan,
  updateArchiveRecordReview,
  updateArchiveRecordReviews,
} from "../src/services/archive";
import { getAuthenticatedUserId } from "../src/middlewares/requireAuth";
import { readReconciliationReport } from "../src/services/reconciliation";
import { syncControlPlaneReviewItems } from "../src/services/review-sync";
import { readWorkload } from "../src/services/workload";
import { resolveRuntimeConfig, runtimeConfig } from "../src/lib/runtime-config";

const ownerA = runtimeConfig.localOwnerId;
const ownerB = "user-b";
const testRoot = process.env.ARCHIVE_TEST_ROOT;

if (!testRoot) throw new Error("ARCHIVE_TEST_ROOT is required.");

after(() => archiveDb.close());

describe("user ownership", { concurrency: false }, () => {
  test("local runtime defaults are stable and production-local binding is loopback-only", () => {
    assert.equal(getAuthenticatedUserId({} as never), "__local__");

    const local = resolveRuntimeConfig({
      AUTH_MODE: "local",
      NODE_ENV: "production",
      PORT: "9123",
    });
    assert.equal(local.authMode, "local");
    assert.equal(local.localOwnerId, "__local__");
    assert.equal(local.host, "127.0.0.1");
    assert.equal(local.port, 9123);
    assert.equal(local.paths.data, join(homedir(), "ARCHIVE", "data"));
    assert.equal(local.paths.downloads, join(homedir(), "ARCHIVE", "downloads"));

    const automaticPort = resolveRuntimeConfig({
      AUTH_MODE: "local",
      NODE_ENV: "production",
      PORT: "0",
    });
    assert.equal(automaticPort.port, 0);

    const clerk = resolveRuntimeConfig({
      AUTH_MODE: "clerk",
      NODE_ENV: "production",
      PORT: "8080",
    });
    assert.equal(clerk.authMode, "clerk");
    assert.equal(clerk.host, "0.0.0.0");
  });

  test("additive migration preserves existing rows and the local owner claims them exactly once", () => {
    assert.equal(claimLegacyData(ownerA), ownerA);
    assert.equal(claimLegacyData(ownerB), ownerA);

    for (const table of [
      "archive_item",
      "source_record",
      "download_job",
      "assistant_conversation",
      "file_record",
    ]) {
      const legacyCount = archiveDb
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_id = ?`)
        .get(LEGACY_OWNER_ID) as { count: number };
      const claimedCount = archiveDb
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_id = ?`)
        .get(ownerA) as { count: number };
      assert.equal(legacyCount.count, 0, `${table} retained legacy rows`);
      assert.ok(claimedCount.count > 0, `${table} was not claimed`);
    }
    assert.equal(
      (archiveDb.prepare(
        "SELECT COUNT(*) AS count FROM system_event WHERE id = 'legacy-event' AND owner_id = ?",
      ).get(ownerA) as { count: number }).count,
      1,
      "the seeded legacy event was not claimed",
    );

    assert.equal(readUserSetting(ownerA, "plexServerUrl"), "http://legacy-plex");
    assert.equal(readUserSetting(ownerA, "plexToken"), "legacy-token");
    assert.equal(readUserSetting(ownerB, "plexServerUrl"), undefined);
    assert.equal(
      (archiveDb.prepare(
        "SELECT COUNT(*) AS count FROM download_job WHERE url = 'https://example.com/legacy'",
      ).get() as { count: number }).count,
      1,
    );
    assert.equal(
      (archiveDb.prepare(
        "SELECT COUNT(*) AS count FROM plex_part WHERE file_path = '/legacy/movie.mkv'",
      ).get() as { count: number }).count,
      1,
    );
    const migratedFile = archiveDb.prepare(
      `SELECT archive_item_id, filename, relative_path, scan_status, modified_at_ms,
              duration_seconds, video_codec, audio_codec, width, height, fingerprint,
              error_message, integrity_classification, local_identity_id, volume_id, archive_root
       FROM file_record WHERE path = '/legacy/archive.mkv' AND owner_id = ?`,
    ).get(ownerA) as Record<string, unknown>;
    assert.deepEqual({ ...migratedFile }, {
      archive_item_id: 1,
      filename: "Legacy.Movie.2024.mkv",
      relative_path: "Legacy.Movie.2024.mkv",
      scan_status: "error",
      modified_at_ms: 1700000000000,
      duration_seconds: 3600.5,
      video_codec: "h264",
      audio_codec: "aac",
      width: 1920,
      height: 1080,
      fingerprint: "legacy-fingerprint",
      error_message: "Invalid Matroska EBML header",
      integrity_classification: "corrupt_or_malformed_container",
      local_identity_id: 1,
      volume_id: "legacy-volume",
      archive_root: "/legacy",
    });
    assert.equal(
      (archiveDb.prepare(
        "SELECT owner_id FROM local_media_identity WHERE id = 1",
      ).get() as { owner_id: string }).owner_id,
      ownerA,
    );
    assert.equal(
      (archiveDb.prepare(
        "SELECT COUNT(*) AS count FROM setting WHERE key IN ('plexServerUrl', 'plexToken')",
      ).get() as { count: number }).count,
      0,
    );
  });

  test("download reads, mutations, queue positions, and subscriptions are owner-isolated", async () => {
    const settings = {
      ...readSettings(),
      temporaryDirectory: join(testRoot, "tmp"),
      archiveDirectory: join(testRoot, "library"),
    };
    await Promise.all([
      mkdir(settings.temporaryDirectory, { recursive: true }),
      mkdir(settings.archiveDirectory, { recursive: true }),
    ]);
    const input = (title: string) => ({
      sourceUrl: `https://example.com/${title.toLowerCase().replaceAll(" ", "-")}`,
      title,
      selectedFormatId: "best",
      temporaryDirectory: settings.temporaryDirectory,
      destinationDirectory: settings.archiveDirectory,
    });

    const eventsA: string[] = [];
    const eventsB: string[] = [];
    const unsubscribeA = subscribeDownloadEvents(ownerA, (event) => eventsA.push(event.type));
    const unsubscribeB = subscribeDownloadEvents(ownerB, (event) => eventsB.push(event.type));

    const firstA = createJob(input("First A"), ownerA, settings);
    const firstB = createJob(input("First B"), ownerB, settings);
    const secondA = createJob(input("Second A"), ownerA, settings);
    unsubscribeA();
    unsubscribeB();

    assert.ok(firstA && firstB && secondA);
    assert.deepEqual(
      readJobs(ownerA).filter((job) => job.sourceUrl !== "https://example.com/legacy").map((job) => job.id).sort(),
      [firstA.id, secondA.id].sort(),
    );
    assert.deepEqual(readJobs(ownerB).map((job) => job.id), [firstB.id]);
    assert.deepEqual(eventsA, ["job.created", "job.created"]);
    assert.deepEqual(eventsB, ["job.created"]);

    assert.throws(() => cancelJob(firstA.id, ownerB), /not found/i);
    assert.equal(
      readJobs(ownerA).find((job) => job.id === firstA.id)?.status,
      "queued",
    );

    const positionsFor = (ownerId: string) =>
      (archiveDb.prepare(
        `SELECT q.position
         FROM queue_item q
         JOIN download_job j ON j.id = q.job_id
         WHERE q.job_type = 'download' AND j.owner_id = ?
         ORDER BY q.position`,
      ).all(ownerId) as Array<{ position: number }>).map((row) => row.position);

    assert.deepEqual(positionsFor(ownerA), [1, 2]);
    assert.deepEqual(positionsFor(ownerB), [1]);
    assert.equal(cancelJob(firstA.id, ownerA)?.status, "cancelled");
  });

  test("events and user-scoped Plex settings do not cross owners", () => {
    addEvent("info", "Only user A can read this", "ownership-test", ownerA);
    addEvent("info", "Only user B can read this", "ownership-test", ownerB);
    writeUserSetting(ownerA, "plexServerUrl", "http://plex-a");
    writeUserSetting(ownerB, "plexServerUrl", "http://plex-b");

    assert.ok(readEvents(ownerA, 100).some((event) => event.message === "Only user A can read this"));
    assert.ok(!readEvents(ownerA, 100).some((event) => event.message === "Only user B can read this"));
    assert.ok(readEvents(ownerB, 100).some((event) => event.message === "Only user B can read this"));
    assert.ok(!readEvents(ownerB, 100).some((event) => event.message === "Only user A can read this"));
    assert.equal(readUserSetting(ownerA, "plexServerUrl"), "http://plex-a");
    assert.equal(readUserSetting(ownerB, "plexServerUrl"), "http://plex-b");
  });

  test("real Plex connection and inventory synchronization are repeatable, isolated, and failure-safe", async () => {
    let failIdentity = false;
    let failSecondLibrary = false;
    let partialSecondLibrary = false;
    let changeFirstLibrary = false;
    let omitBeta = false;
    let requestCount = 0;
    const plexServer = createServer((req, res) => {
      requestCount += 1;
      res.setHeader("Content-Type", "application/json");
      if (req.headers["x-plex-token"] !== "valid-token") {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/identity") {
        if (failIdentity) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: "identity unavailable" }));
          return;
        }
        res.end(JSON.stringify({ MediaContainer: { friendlyName: "Test Plex" } }));
        return;
      }
      if (url.pathname === "/library/sections") {
        res.end(JSON.stringify({
          MediaContainer: {
            Directory: [
              { key: "1", title: "Movies", type: "movie" },
              ...(failSecondLibrary ? [{ key: "2", title: "Shows", type: "show" }] : []),
            ],
          },
        }));
        return;
      }
      if (url.pathname === "/library/sections/1/all") {
        const allItems = changeFirstLibrary
          ? [{ ratingKey: "102", title: "Gamma", type: "movie", year: 2026, Media: [] }]
          : [
            {
              ratingKey: "100",
              title: "Alpha",
              type: "movie",
              year: 2024,
              addedAt: 1_700_000_000,
              thumb: "/library/metadata/100/thumb",
              Media: [{
                videoResolution: "1080",
                videoCodec: "h264",
                audioCodec: "aac",
                bitrate: 8000,
                duration: 7_200_000,
                Part: [{ file: "/media/alpha.mkv", size: 1_000_000, hash: "alpha" }],
              }],
            },
            {
              ratingKey: "101",
              title: "Beta",
              type: "movie",
              year: 2025,
              Media: [],
            },
          ];
        const visibleItems = omitBeta ? allItems.filter((item) => item.ratingKey !== "101") : allItems;
        const offset = Number(url.searchParams.get("X-Plex-Container-Start") ?? 0);
        res.end(JSON.stringify({
          MediaContainer: {
            totalSize: visibleItems.length,
            Metadata: visibleItems.slice(offset, offset + 1),
          },
        }));
        return;
      }
      if (url.pathname === "/library/sections/2/all" && failSecondLibrary) {
        if (partialSecondLibrary) {
          res.end(JSON.stringify({ MediaContainer: { totalSize: 1, Metadata: [{ ratingKey: "show-1", title: "Incomplete Show", type: "show" }] } }));
          return;
        }
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "second library unavailable" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => plexServer.listen(0, "127.0.0.1", resolve));
    const address = plexServer.address();
    if (!address || typeof address === "string") throw new Error("Mock Plex server did not start.");
    const serverUrl = `http://127.0.0.1:${address.port}`;

    try {
      savePlexConfig(ownerA, { serverUrl, token: "valid-token" });
      savePlexConfig(ownerB, { serverUrl, token: "invalid-token" });

      startPlexSync(ownerA);
      assert.throws(() => startPlexSync(ownerA), /already running/i);
      for (let attempt = 0; attempt < 20 && getPlexConfig(ownerA).syncStatus === "syncing"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(getPlexConfig(ownerA).syncStatus, "synced");

      assert.ok(["connected", "synced"].includes((await testPlexConnection(ownerA)).status));
      assert.equal(getPlexConfig(ownerA).connectionStatus, "connected");
      const failedConnection = await testPlexConnection(ownerB);
      assert.equal(failedConnection.status, "connection_failed");
      assert.equal(failedConnection.connectionStatus, "connection_failed");
      assert.match(failedConnection.lastError ?? "", /HTTP 401/);

      await syncPlexInventory(ownerA);
      const firstConfig = getPlexConfig(ownerA);
      assert.equal(firstConfig.status, "synced");
      assert.equal(firstConfig.connectionStatus, "connected");
      assert.equal(firstConfig.syncStatus, "synced");
      assert.equal(firstConfig.serverName, "Test Plex");
      assert.equal(firstConfig.libraryCount, 1);
      assert.equal(firstConfig.itemCount, 2);
      assert.equal(firstConfig.mediaCount, 1);
      assert.ok(firstConfig.lastAttemptedAt);
      assert.ok(firstConfig.lastSuccessfulSyncAt);
      assert.ok(firstConfig.lastSuccessfulRefreshId);
      const firstSuccessfulRefreshId = firstConfig.lastSuccessfulRefreshId;
      const firstRefreshAudit = archiveDb.prepare(
        "SELECT status, snapshot_completeness, authoritative, item_count FROM provider_refresh WHERE refresh_id = ? AND owner_id = ?",
      ).get(firstSuccessfulRefreshId, ownerA) as { status: string; snapshot_completeness: string; authoritative: number; item_count: number };
      assert.equal(firstRefreshAudit.status, "synced");
      assert.equal(firstRefreshAudit.snapshot_completeness, "complete");
      assert.equal(firstRefreshAudit.authoritative, 1);
      assert.equal(firstRefreshAudit.item_count, 2);
      const completeInventory = readPlexInventory(ownerA);
      const completeRefreshId = firstConfig.lastSuccessfulRefreshId;
      omitBeta = true;
      failSecondLibrary = true;
      partialSecondLibrary = true;
      await syncPlexInventory(ownerA);
      const partialConfig = getPlexConfig(ownerA);
      assert.equal(partialConfig.syncStatus, "sync_error");
      assert.equal(partialConfig.snapshotCompleteness, "partial");
      assert.equal(partialConfig.lastSuccessfulRefreshId, completeRefreshId);
      const partialRefreshAudit = archiveDb.prepare(
        "SELECT status, snapshot_completeness, authoritative FROM provider_refresh WHERE refresh_id = ? AND owner_id = ?",
      ).get(partialConfig.lastAttemptedRefreshId, ownerA) as { status: string; snapshot_completeness: string; authoritative: number };
      assert.equal(partialRefreshAudit.status, "sync_error");
      assert.equal(partialRefreshAudit.snapshot_completeness, "partial");
      assert.equal(partialRefreshAudit.authoritative, 0);
      assert.deepEqual(readPlexInventory(ownerA), completeInventory);

      failSecondLibrary = false;
      partialSecondLibrary = false;
      await syncPlexInventory(ownerA);
      const completeAbsenceConfig = getPlexConfig(ownerA);
      assert.equal(completeAbsenceConfig.syncStatus, "synced");
      assert.equal(completeAbsenceConfig.snapshotCompleteness, "complete");
      assert.notEqual(completeAbsenceConfig.lastSuccessfulRefreshId, completeRefreshId);
      assert.equal(readPlexInventory(ownerA).items.length, 1);
      const supersededBeta = archiveDb.prepare(
        "SELECT state, payload_json FROM review_item WHERE owner_id = ? AND subject_key = 'provider-only:plex:101'",
      ).get(ownerA) as { state: string; payload_json: string } | undefined;
      assert.equal(supersededBeta?.state, "rejected");
      assert.equal(JSON.parse(supersededBeta?.payload_json ?? "{}").lifecycleStatus, "superseded");
      omitBeta = false;
      await syncPlexInventory(ownerA);

      const firstInventory = readPlexInventory(ownerA);
      assert.equal(firstInventory.libraries.length, 1);
      assert.equal(firstInventory.items.length, 2);
      assert.equal(firstInventory.items.find((item) => item.ratingKey === "100")?.partCount, 1);
      assert.deepEqual(readPlexInventory(ownerB), { libraries: [], items: [] });

      const reconciliationOwner = `plex-reconciliation-owner-${Date.now()}`;
      savePlexConfig(reconciliationOwner, { serverUrl, token: "valid-token" });
      await syncPlexInventory(reconciliationOwner);
      const localAlpha = archiveDb.prepare(`
        INSERT INTO file_record
          (path, size_bytes, checksum, owner_id, filename, relative_path, scan_status, archive_root)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
      `).run("/media/alpha.mkv", 1_000_000, "alpha-local", reconciliationOwner, "Alpha.2024.mkv", "Alpha.2024.mkv", "/media");
      const reconciliation = await readReconciliationReport(reconciliationOwner, 1, 100);
      assert.equal(reconciliation.summary.matchedCount, 0, JSON.stringify(reconciliation.summary));
      assert.equal(reconciliation.summary.qualityConflictCount, 1, JSON.stringify(reconciliation.summary));
      assert.equal(reconciliation.summary.plexOnlyCount, 1, JSON.stringify(reconciliation.summary));
      assert.ok(reconciliation.results.some((result) => result.classification === "quality_conflict"));
      invalidateArchiveInventoryCache(reconciliationOwner);
      await syncControlPlaneReviewItems(reconciliationOwner);
      const qualityItems = (archiveDb.prepare(
        "SELECT id, subject_key, payload_json FROM review_item WHERE owner_id = ? AND kind = 'archive_finding' AND state IN ('pending', 'reopened')",
      ).all(reconciliationOwner) as Array<{ id: number; subject_key: string; payload_json: string }>);
      const qualityItem = qualityItems.find((item) => {
        const payload = JSON.parse(item.payload_json) as { classification?: string; qualityStatus?: string };
        return payload.classification === "quality_conflict";
      });
      assert.ok(qualityItem, "quality conflict must become an actionable finding");
      assert.equal(qualityItem?.subject_key, `archive-finding:${Number(localAlpha.lastInsertRowid)}`);
      const qualityPayload = JSON.parse(qualityItem?.payload_json ?? "{}") as { classification?: string; qualityStatus?: string; snapshot?: { refreshId?: string } };
      assert.equal(qualityPayload.classification, "quality_conflict");
      assert.ok(qualityPayload.qualityStatus);
      assert.equal(qualityPayload.snapshot?.refreshId, getPlexConfig(reconciliationOwner).lastSuccessfulRefreshId);
      const currentObservation = archiveDb.prepare(
        "SELECT id, evidence_key FROM review_item_observation WHERE owner_id = ? AND subject_key = ? AND status = 'active'",
      ).get(reconciliationOwner, qualityItem?.subject_key) as { id: number; evidence_key: string };
      const workloadBeforeRepeat = await readWorkload(reconciliationOwner);
      const lineageItem = workloadBeforeRepeat.items.find((item) => item.id === `review:${qualityItem?.id}`);
      assert.ok(lineageItem, "quality conflict must remain in workload");
      assert.equal(lineageItem?.reviewItemId, qualityItem?.id);
      assert.equal(lineageItem?.currentObservationId, currentObservation.id);
      assert.equal(lineageItem?.findingClassification, "quality_conflict");
      assert.equal(lineageItem?.provider, "plex");
      assert.equal(lineageItem?.refreshId, getPlexConfig(reconciliationOwner).lastSuccessfulRefreshId);
      assert.equal(lineageItem?.evidenceKey, currentObservation.evidence_key);
      await syncControlPlaneReviewItems(reconciliationOwner);
      const activeQualityCount = (archiveDb.prepare(
        "SELECT COUNT(*) AS count FROM review_item WHERE owner_id = ? AND kind = 'archive_finding' AND subject_key = ? AND state IN ('pending', 'reopened')",
      ).get(reconciliationOwner, qualityItem?.subject_key) as { count: number }).count;
      assert.equal(activeQualityCount, 1);
      const firstObservation = archiveDb.prepare(
        "SELECT id, evidence_key FROM review_item_observation WHERE owner_id = ? AND subject_key = ? AND status = 'active'",
      ).get(reconciliationOwner, qualityItem?.subject_key) as { id: number; evidence_key: string };
      archiveDb.prepare("UPDATE file_record SET height = 720 WHERE id = ? AND owner_id = ?").run(Number(localAlpha.lastInsertRowid), reconciliationOwner);
      invalidateArchiveInventoryCache(reconciliationOwner);
      await syncControlPlaneReviewItems(reconciliationOwner);
      const observations = archiveDb.prepare(
        "SELECT id, evidence_key, status FROM review_item_observation WHERE owner_id = ? AND subject_key = ? ORDER BY id",
      ).all(reconciliationOwner, qualityItem?.subject_key) as Array<{ id: number; evidence_key: string; status: string }>;
      assert.equal(observations.length, 2);
      assert.equal(observations[0].status, "superseded");
      assert.equal(observations[1].status, "active");
      assert.notEqual(observations[0].evidence_key, observations[1].evidence_key);
      assert.equal(observations[0].evidence_key, firstObservation.evidence_key);
      assert.equal((archiveDb.prepare(
        "SELECT COUNT(*) AS count FROM review_item WHERE owner_id = ? AND kind = 'archive_finding' AND subject_key = ? AND state IN ('pending', 'reopened')",
      ).get(reconciliationOwner, qualityItem?.subject_key) as { count: number }).count, 1);
      const workloadAfterEvidenceChange = await readWorkload(reconciliationOwner);
      const explainedItem = workloadAfterEvidenceChange.items.find((item) => item.reviewItemId === qualityItem?.id);
      assert.ok(explainedItem);
      assert.equal(explainedItem?.currentObservationId, observations[1].id);
      assert.equal(explainedItem?.evidenceKey, observations[1].evidence_key);
      assert.ok(explainedItem?.observedAt);
      assert.equal(explainedItem?.changeContext?.previousObservationId, observations[0].id);
      assert.equal(explainedItem?.changeContext?.previousEvidenceKey, observations[0].evidence_key);
      await syncControlPlaneReviewItems(reconciliationOwner);
      assert.equal((archiveDb.prepare(
        "SELECT COUNT(*) AS count FROM review_item_observation WHERE owner_id = ? AND subject_key = ?",
      ).get(reconciliationOwner, qualityItem?.subject_key) as { count: number }).count, 2);
      assert.equal((await readWorkload(reconciliationOwner)).items.filter((item) => item.reviewItemId === qualityItem?.id).length, 1);
      archiveDb.prepare("DELETE FROM file_record WHERE id = ? AND owner_id = ?").run(Number(localAlpha.lastInsertRowid), reconciliationOwner);
      archiveDb.prepare("DELETE FROM plex_item WHERE owner_id = ?").run(reconciliationOwner);
      archiveDb.prepare("DELETE FROM plex_library WHERE owner_id = ?").run(reconciliationOwner);

      await syncPlexInventory(ownerA);
      assert.equal(readPlexInventory(ownerA).libraries.length, 1);
      assert.equal(readPlexInventory(ownerA).items.length, 2);

      failIdentity = true;
      const connectionAfterSync = await testPlexConnection(ownerA);
      assert.equal(connectionAfterSync.status, "connection_failed");
      assert.equal(connectionAfterSync.connectionStatus, "connection_failed");
      assert.equal(connectionAfterSync.syncStatus, "synced");
      failIdentity = false;
      assert.equal((await testPlexConnection(ownerA)).connectionStatus, "connected");

      savePlexConfig(ownerB, { token: "valid-token" });
      await syncPlexInventory(ownerB);
      assert.equal(readPlexInventory(ownerB).items.length, 2);
      assert.equal(
        (archiveDb.prepare(
          "SELECT COUNT(*) AS count FROM plex_item WHERE rating_key IN ('100', '101')",
        ).get() as { count: number }).count,
        readPlexInventory(ownerA).items.length + readPlexInventory(ownerB).items.length,
      );

      const beforeFailure = readPlexInventory(ownerA);
      const beforeFailureConfig = getPlexConfig(ownerA);
      failSecondLibrary = true;
      changeFirstLibrary = true;
      await syncPlexInventory(ownerA);
      const failedConfig = getPlexConfig(ownerA);
      assert.equal(failedConfig.status, "sync_error");
      assert.equal(failedConfig.syncStatus, "sync_error");
      assert.match(failedConfig.lastError ?? "", /HTTP 503/);
      assert.equal(failedConfig.lastSuccessfulSyncAt, beforeFailureConfig.lastSuccessfulSyncAt);
      assert.equal(failedConfig.lastSuccessfulRefreshId, beforeFailureConfig.lastSuccessfulRefreshId);
      const failedRefreshAudit = archiveDb.prepare(
        "SELECT status, snapshot_completeness, authoritative FROM provider_refresh WHERE refresh_id = ? AND owner_id = ?",
      ).get(failedConfig.lastAttemptedRefreshId, ownerA) as { status: string; snapshot_completeness: string; authoritative: number };
      assert.equal(failedRefreshAudit.status, "sync_error");
      assert.equal(failedRefreshAudit.snapshot_completeness, "unknown");
      assert.equal(failedRefreshAudit.authoritative, 0);
      assert.notEqual(failedConfig.lastAttemptedRefreshId, beforeFailureConfig.lastSuccessfulRefreshId);
      assert.deepEqual(readPlexInventory(ownerA), beforeFailure);
      failSecondLibrary = false;
      changeFirstLibrary = false;
      await syncPlexInventory(ownerA);
      const recoveredConfig = getPlexConfig(ownerA);
      assert.equal(recoveredConfig.syncStatus, "synced");
      assert.notEqual(recoveredConfig.lastSuccessfulRefreshId, firstSuccessfulRefreshId);

      savePlexConfig("user-c", { serverUrl: "http://169.254.169.254", token: "valid-token" });
      const blockedTarget = await testPlexConnection("user-c");
      assert.equal(blockedTarget.connectionStatus, "connection_failed");
      assert.match(blockedTarget.lastError ?? "", /blocked link-local/i);

      const requestsBeforeOfflineCheck = requestCount;
      writeSettings({ networkMode: "offline" });
      savePlexConfig("user-offline", { serverUrl, token: "valid-token" });
      const offlineTarget = await testPlexConnection("user-offline");
      assert.equal(offlineTarget.connectionStatus, "connection_failed");
      assert.match(offlineTarget.lastError ?? "", /network mode is offline/i);
      assert.equal(requestCount, requestsBeforeOfflineCheck);
      writeSettings({ networkMode: "local_only" });

      archiveDb.exec("PRAGMA wal_checkpoint(FULL)");
      const reopened = new DatabaseSync(process.env.ARCHIVE_DB_PATH);
      try {
        assert.equal(
          (reopened.prepare(
            "SELECT COUNT(*) AS count FROM plex_item WHERE owner_id = ? AND rating_key IN ('100', '101')",
          ).get(ownerA) as { count: number }).count,
          2,
        );
      } finally {
        reopened.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => plexServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("archive scans persist FFprobe metadata, evidence, missing files, Plex comparisons, and owner isolation", async () => {
    const archiveDirectory = join(testRoot, "archive-library");
    const downloadDirectory = join(testRoot, "archive-downloads");
    const ffprobePath = join(testRoot, "fake-ffprobe.mjs");
    await mkdir(archiveDirectory, { recursive: true });
    await mkdir(downloadDirectory, { recursive: true });
    await writeFile(ffprobePath, `#!/usr/bin/env node
const file = process.argv.at(-1) ?? "";
import { unlinkSync } from "node:fs";
if (file.includes("Corrupt")) {
  process.stderr.write("Invalid Matroska EBML header");
  process.exit(1);
}
if (file.includes("ChecksumFailure")) {
  unlinkSync(file);
}
const is2160 = file.includes("2160") || file.includes("Alpha");
process.stdout.write(JSON.stringify({
  format: {
    duration: file.includes("Movie") ? "7200.25" : "3600.5",
    bit_rate: is2160 ? "28000000" : "8000000",
    format_name: "matroska,webm"
  },
  streams: [
    {
      codec_type: "video",
      codec_name: is2160 ? "hevc" : "h264",
      width: is2160 ? 3840 : 1920,
      height: is2160 ? 2160 : 1080,
      r_frame_rate: "24000/1001",
      color_transfer: is2160 ? "smpte2084" : "bt709"
    },
    {
      codec_type: "audio",
      codec_name: "eac3",
      channels: 6,
      tags: { language: "eng" }
    },
    {
      codec_type: "subtitle",
      codec_name: "subrip",
      tags: { language: "spa" }
    }
  ]
}));`);
    await chmod(ffprobePath, 0o755);

    const files = {
      alpha: join(archiveDirectory, "Alpha.2024.mkv"),
      low: join(archiveDirectory, "Movie.2025.1080p.mkv"),
      high: join(archiveDirectory, "Movie.2025.2160p.mkv"),
      copyOne: join(downloadDirectory, "Copy.One.mkv"),
      copyTwo: join(downloadDirectory, "Copy.Two.mkv"),
      corrupt: join(downloadDirectory, "Corrupt.mp4"),
      checksumFailure: join(downloadDirectory, "ChecksumFailure.mkv"),
    };
    await Promise.all([
      writeFile(files.alpha, "alpha-media"),
      writeFile(files.low, "movie-low"),
      writeFile(files.high, "movie-high"),
      writeFile(files.copyOne, "identical-media"),
      writeFile(files.copyTwo, "identical-media"),
      writeFile(files.corrupt, "corrupt"),
      writeFile(files.checksumFailure, "checksum-failure"),
    ]);
    writeSettings({
      archiveDirectory: JSON.stringify([archiveDirectory, downloadDirectory]),
      downloadDirectory,
      ffprobePath,
    });

    const waitForScan = async (ownerId: string) => {
      startArchiveScan(ownerId);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const state = readArchiveScan(ownerId);
        if (state.status !== "scanning") return state;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Archive scan did not finish.");
    };

    const firstScan = await waitForScan(ownerA);
    assert.equal(firstScan.status, "completed");
    assert.equal(firstScan.scannedFiles, 7);
    assert.equal(firstScan.failedFiles, 2, JSON.stringify(readEvents(ownerA, 20)));

    const inventory = readArchiveInventory(ownerA);
    assert.equal(inventory.records.length, 8);
    const alpha = inventory.records.find((record) => record.filename === "Alpha.2024.mkv");
    assert.equal(alpha?.height, 2160);
    assert.equal(alpha?.audioChannels, 6);
    assert.deepEqual(alpha?.audioLanguages, ["eng"]);
    assert.deepEqual(alpha?.subtitleLanguages, ["spa"]);
    assert.equal(alpha?.plexMatch?.title, "Alpha");
    assert.equal(alpha?.qualityStatus, "higher_quality_available");

    const low = inventory.records.find((record) => record.filename.includes("1080p"));
    const high = inventory.records.find((record) => record.filename.includes("2160p"));
    assert.equal(low?.qualityStatus, "lower_quality_version");
    assert.equal(high?.qualityStatus, "best_local_version");
    assert.ok(low?.qualityDifferences.some((difference) => difference.includes("resolution")));
    if (!low) throw new Error("Expected the lower-quality archive record.");
    const reviewed = updateArchiveRecordReview(ownerA, low.id, "reviewed", "Keep the higher-resolution local copy.");
    assert.equal(reviewed?.status, "reviewed");
    assert.equal(reviewed?.note, "Keep the higher-resolution local copy.");
    assert.equal(updateArchiveRecordReview(ownerB, low.id, "reviewed", null), null);
    assert.equal(readArchiveInventory(ownerA).records.find((record) => record.id === low.id)?.reviewStatus, "reviewed");
    assert.equal(readArchiveInventory(ownerB).records.find((record) => record.id === low.id), undefined);

    const duplicateRows = inventory.records.filter((record) => record.qualityStatus === "duplicate");
    assert.equal(duplicateRows.length, 2);
    assert.ok(duplicateRows.every((record) => record.qualitySummary.includes("SHA-256")));
    assert.equal(inventory.records.find((record) => record.filename === "Corrupt.mp4")?.scanStatus, "error");
    const corrupt = inventory.records.find((record) => record.filename === "Corrupt.mp4");
    assert.equal(corrupt?.integrityClassification, "corrupt_or_malformed_container");
    assert.match(corrupt?.integritySummary ?? "", /corrupt or malformed/i);
    assert.match(corrupt?.errorMessage ?? "", /Invalid Matroska EBML header/i);
    assert.equal(inventory.summary.integrityFailureCount, 2);
    assert.equal(inventory.summary.healthStatus, "attention_required");
    const checksumFailure = inventory.records.find((record) => record.filename === "ChecksumFailure.mkv");
    assert.equal(checksumFailure?.scanStatus, "error");
    assert.equal(checksumFailure?.integrityClassification, "inspection_unavailable");
    assert.match(checksumFailure?.errorMessage ?? "", /ENOENT|no such file/i);
    assert.equal(inventory.summary.inspectionFailureCount, 1);
    assert.ok(inventory.plexOnly.some((record) => record.title === "Beta"));
    assert.deepEqual(readArchiveInventory(ownerB).records, []);

    if (!corrupt) throw new Error("Expected the corrupt archive record.");
    archiveDb.prepare(
      "UPDATE file_record SET integrity_classification = ?, error_message = ? WHERE id = ? AND owner_id = ?",
    ).run(
      "corrupt_or_malformed_container",
      "spawn C:\\tools\\ffprobe.exe EACCES",
      corrupt.id,
      ownerA,
    );
    invalidateArchiveInventoryCache(ownerA);
    const storedClassification = readArchiveInventory(ownerA).records.find((record) => record.id === corrupt.id);
    assert.equal(storedClassification?.integrityClassification, "corrupt_or_malformed_container");

    await waitForScan(ownerA);
    assert.equal(readArchiveInventory(ownerA).records.length, 8);
    assert.equal(readArchiveInventory(ownerA).records.find((record) => record.id === low.id)?.reviewStatus, "reviewed");
    assert.equal(
      (archiveDb.prepare("SELECT COUNT(*) AS count FROM file_record WHERE owner_id = ?").get(ownerA) as { count: number }).count,
      8,
    );

    await writeFile(files.low, "movie-low-with-changed-evidence");
    await waitForScan(ownerA);
    const reopenedFinding = readArchiveInventory(ownerA).records.find((record) => record.id === low.id);
    assert.equal(reopenedFinding?.qualityStatus, "lower_quality_version");
    assert.equal(reopenedFinding?.reviewStatus, "unreviewed");
    assert.equal(updateArchiveRecordReview(ownerA, low.id, "deferred", "Review after storage cleanup.")?.status, "deferred");
    assert.equal(updateArchiveRecordReview(ownerA, low.id, "unresolved", null)?.status, "unresolved");
    const bulkNoteCases = [
      { id: low.id, status: "reviewed" as const, note: "Bulk reviewed after evidence refresh." },
      { id: duplicateRows[0].id, status: "deferred" as const, note: "Bulk defer until storage cleanup." },
      { id: duplicateRows[1].id, status: "unresolved" as const, note: "Bulk unresolved pending an operator decision." },
    ];
    for (const { id, status, note } of bulkNoteCases) {
      const result = updateArchiveRecordReviews(ownerA, [id], status, note);
      assert.equal(result.succeeded, 1);
      assert.equal(result.failed, 0);
      assert.equal(result.results[0].review?.status, status);
      assert.equal(result.results[0].review?.note, note);
      assert.equal(readArchiveInventory(ownerA).records.find((record) => record.id === id)?.reviewNote, note);
    }
    const nonReviewable = readArchiveInventory(ownerA).records.find((record) => record.reviewStatus === "not_applicable");
    if (!nonReviewable) throw new Error("Expected a non-reviewable archive record.");
    const bulkReview = updateArchiveRecordReviews(ownerA, [low.id, nonReviewable.id, 999_999], "reviewed", null);
    assert.equal(bulkReview.attempted, 3);
    assert.equal(bulkReview.succeeded, 1);
    assert.equal(bulkReview.failed, 2);
    assert.deepEqual(bulkReview.results.map((result) => result.success), [true, false, false]);
    assert.equal(bulkReview.results[0].review?.note, null);
    assert.match(bulkReview.results[1].error ?? "", /no active duplicate or quality finding/i);
    assert.match(bulkReview.results[2].error ?? "", /not found/i);
    assert.equal(readArchiveInventory(ownerA).records.find((record) => record.id === low.id)?.reviewStatus, "reviewed");
    assert.equal(readArchiveInventory(ownerA).records.find((record) => record.id === low.id)?.reviewNote, null);
    assert.equal(readArchiveInventory(ownerB).records.find((record) => record.id === low.id), undefined);

    await unlink(files.copyTwo);
    const missingScan = await waitForScan(ownerA);
    assert.equal(missingScan.status, "completed");
    const afterMissing = readArchiveInventory(ownerA);
    assert.equal(afterMissing.summary.missingCount, 2);
    assert.equal(afterMissing.records.find((record) => record.filename === "Copy.Two.mkv")?.qualityStatus, "file_missing");

    archiveDb.exec("PRAGMA wal_checkpoint(FULL)");
    const reopened = new DatabaseSync(process.env.ARCHIVE_DB_PATH);
    try {
      assert.equal(
        (reopened.prepare("SELECT COUNT(*) AS count FROM file_record WHERE owner_id = ?").get(ownerA) as { count: number }).count,
        8,
      );
      assert.equal(
        (reopened.prepare("SELECT status FROM archive_scan WHERE owner_id = ?").get(ownerA) as { status: string }).status,
        "completed",
      );
      assert.equal(
        (reopened.prepare("SELECT COUNT(*) AS count FROM archive_review WHERE owner_id = ? AND file_record_id = ?").get(ownerA, low.id) as { count: number }).count,
        2,
      );
    } finally {
      reopened.close();
    }
  });
});
describe("legacy claim covers every owned table", () => {
  test("legacyOwnedTables matches the tables the schema actually owns", () => {
    // Derived from the live schema rather than restated by hand: a new table
    // with an owner_id defaulting to the legacy sentinel would otherwise keep
    // its pre-authentication rows permanently unreachable after a claim, and
    // a hand-maintained expectation would be updated in the same commit that
    // introduced the bug. This is how jellyfin_library/jellyfin_item were
    // found to be missing.
    const tables = archiveDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;

    const ownedBySchema = tables
      .filter(({ name }) => {
        const columns = archiveDb.prepare(`PRAGMA table_info(${name})`).all() as Array<{
          name: string;
          dflt_value: string | null;
        }>;
        const ownerColumn = columns.find((column) => column.name === "owner_id");
        // user_setting is keyed by owner and never holds legacy-sentinel rows.
        return Boolean(ownerColumn?.dflt_value?.includes(LEGACY_OWNER_ID));
      })
      .map(({ name }) => name)
      .sort();

    assert.deepEqual(
      [...legacyOwnedTables].sort(),
      ownedBySchema,
      "every table defaulting owner_id to the legacy sentinel must be claimed by claimLegacyData()",
    );
  });
});
