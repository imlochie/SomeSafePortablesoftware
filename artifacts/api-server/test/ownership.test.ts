import "./integrations.test";
import { integrations } from "../src/integrations";
import { GetIntegrationInventoryResponse } from "@workspace/api-zod";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { after, describe, test } from "node:test";
import {
  LEGACY_OWNER_ID,
  addEvent,
  archiveDb,
  claimLegacyData,
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
import { prepareDownload } from "../src/services/media";
import {
  getPlexConfig,
  readPlexInventory,
  savePlexConfig,
  syncPlexInventory,
  testPlexConnection,
} from "../src/services/plex";
import {
  readArchiveInventory,
  readArchiveScan,
  startArchiveScan,
  updateArchiveRecordReview,
  updateArchiveRecordReviews,
} from "../src/services/archive";
import { readNamingProposals, setNamingProposalDecisions } from "../src/services/naming-intelligence";
import {
  ArchiveMutationError,
  applyNamingProposals,
  createOperation,
  executeOperation,
  readOperations,
  rollbackOperation,
  validateMutationPaths,
} from "../src/services/archive-operations";
import { getAuthenticatedUserId } from "../src/middlewares/requireAuth";
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
      "system_event",
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
    assert.equal(
      (archiveDb.prepare(
        "SELECT COUNT(*) AS count FROM setting WHERE key IN ('plexServerUrl', 'plexToken')",
      ).get() as { count: number }).count,
      0,
    );
  });

  test("download reads, mutations, queue positions, and subscriptions are owner-isolated", () => {
    const settings = {
      ...readSettings(),
      temporaryDirectory: join(testRoot, "tmp"),
      archiveDirectory: join(testRoot, "library"),
    };
    const input = (title: string) => ({
      sourceUrl: `https://example.com/${title.toLowerCase().replaceAll(" ", "-")}`,
      title,
      selectedFormatId: "best",
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
    let changeFirstLibrary = false;
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
        const offset = Number(url.searchParams.get("X-Plex-Container-Start") ?? 0);
        res.end(JSON.stringify({
          MediaContainer: {
            totalSize: allItems.length,
            Metadata: allItems.slice(offset, offset + 1),
          },
        }));
        return;
      }
      if (url.pathname === "/library/sections/2/all" && failSecondLibrary) {
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

      assert.equal((await testPlexConnection(ownerA)).status, "connected");
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

      // Exercise the real Plex transport through the generic adapter against the test-only server.
      assert.equal((await integrations.testConnection(ownerA, "plex")).state, "connected");
      const normalized = GetIntegrationInventoryResponse.parse(await integrations.execute(ownerA, "plex", "media_host_inventory"));
      assert.equal(normalized.items.length, 2);
      assert.equal(normalized.cached, true);
      assert.ok(normalized.lastSuccessfulSyncAt);
      assert.deepEqual(Object.keys(normalized.items[0]).sort(), ["id", "kind", "title", "year"]);
      assert.doesNotMatch(JSON.stringify(normalized), /ratingKey|serverUrl|valid-token|MediaContainer/);
      assert.deepEqual((await integrations.execute(ownerB, "plex", "media_host_inventory")).items, []);

      const firstInventory = readPlexInventory(ownerA);
      assert.equal(firstInventory.libraries.length, 1);
      assert.equal(firstInventory.items.length, 2);
      assert.equal(firstInventory.items.find((item) => item.ratingKey === "100")?.partCount, 1);
      assert.deepEqual(readPlexInventory(ownerB), { libraries: [], items: [] });

      await syncPlexInventory(ownerA);
      assert.equal(readPlexInventory(ownerA).libraries.length, 1);
      assert.equal(readPlexInventory(ownerA).items.length, 2);

      failIdentity = true;
      const connectionAfterSync = await testPlexConnection(ownerA);
      assert.equal(connectionAfterSync.status, "connection_failed");
      assert.equal(connectionAfterSync.connectionStatus, "connection_failed");
      assert.equal(connectionAfterSync.syncStatus, "synced");
      assert.equal(integrations.describe(ownerA, "plex").state, "disconnected");
      assert.equal((await integrations.execute(ownerA, "plex", "media_host_inventory")).items.length, 2);
      failIdentity = false;
      assert.equal((await testPlexConnection(ownerA)).connectionStatus, "connected");

      savePlexConfig(ownerB, { token: "valid-token" });
      await syncPlexInventory(ownerB);
      assert.equal(readPlexInventory(ownerB).items.length, 2);
      assert.equal(
        (archiveDb.prepare(
          "SELECT COUNT(*) AS count FROM plex_item WHERE rating_key IN ('100', '101')",
        ).get() as { count: number }).count,
        4,
      );

      const beforeFailure = readPlexInventory(ownerA);
      failSecondLibrary = true;
      changeFirstLibrary = true;
      await syncPlexInventory(ownerA);
      assert.equal(getPlexConfig(ownerA).status, "sync_error");
      assert.match(getPlexConfig(ownerA).lastError ?? "", /HTTP 503/);
      assert.deepEqual(readPlexInventory(ownerA), beforeFailure);
      failSecondLibrary = false;
      changeFirstLibrary = false;

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
if (file.includes("Corrupt")) {
  process.stderr.write("invalid media");
  process.exit(1);
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
    };
    await Promise.all([
      writeFile(files.alpha, "alpha-media"),
      writeFile(files.low, "movie-low"),
      writeFile(files.high, "movie-high"),
      writeFile(files.copyOne, "identical-media"),
      writeFile(files.copyTwo, "identical-media"),
      writeFile(files.corrupt, "corrupt"),
    ]);
    writeSettings({
      archiveDirectory,
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
    assert.equal(firstScan.scannedFiles, 6);
    assert.equal(firstScan.failedFiles, 1, JSON.stringify(readEvents(ownerA, 20)));

    const inventory = readArchiveInventory(ownerA);
    assert.equal(inventory.records.length, 7);
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
    assert.ok(inventory.plexOnly.some((record) => record.title === "Beta"));
    assert.deepEqual(readArchiveInventory(ownerB).records, []);

    await waitForScan(ownerA);
    assert.equal(readArchiveInventory(ownerA).records.length, 7);
    assert.equal(readArchiveInventory(ownerA).records.find((record) => record.id === low.id)?.reviewStatus, "reviewed");
    assert.equal(
      (archiveDb.prepare("SELECT COUNT(*) AS count FROM file_record WHERE owner_id = ?").get(ownerA) as { count: number }).count,
      7,
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
    assert.equal(afterMissing.summary.missingCount, 1);
    assert.equal(afterMissing.records.find((record) => record.filename === "Copy.Two.mkv")?.qualityStatus, "file_missing");

    archiveDb.exec("PRAGMA wal_checkpoint(FULL)");
    const reopened = new DatabaseSync(process.env.ARCHIVE_DB_PATH);
    try {
      assert.equal(
        (reopened.prepare("SELECT COUNT(*) AS count FROM file_record WHERE owner_id = ?").get(ownerA) as { count: number }).count,
        7,
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

  test("prepare download falls back to the configured temporary directory and still rejects unsafe explicit paths", () => {
    const scoped = {
      ...readSettings(),
      temporaryDirectory: join(testRoot, "tmp"),
      archiveDirectory: join(testRoot, "library"),
    };
    const source = (title: string) => ({
      sourceUrl: `https://example.com/${title.toLowerCase().replaceAll(" ", "-")}`,
      title,
      selectedFormatId: "best",
    });

    // Omitting temporaryDirectory now resolves to the persisted setting.
    const fallback = prepareDownload(source("Fallback One"), scoped);
    assert.equal(fallback.temporaryDirectory, resolve(join(testRoot, "tmp")));

    // An explicit client value inside the configured root is preserved.
    const explicit = prepareDownload(
      { ...source("Explicit One"), temporaryDirectory: join(testRoot, "tmp", "client") },
      scoped,
    );
    assert.equal(explicit.temporaryDirectory, resolve(join(testRoot, "tmp", "client")));

    // An explicit value outside the configured root is still rejected.
    assert.throws(
      () => prepareDownload({ ...source("Unsafe One"), temporaryDirectory: "/etc" }, scoped),
      /limited to configured Archive Assistant directories/,
    );

    // Traversal segments cannot escape the configured root either.
    assert.throws(
      () => prepareDownload(
        { ...source("Traversal One"), temporaryDirectory: join(testRoot, "tmp", "..", "..", "escape") },
        scoped,
      ),
      /limited to configured Archive Assistant directories/,
    );

    // Nothing is invented when neither the request nor settings name a directory.
    assert.throws(
      () => prepareDownload(source("Unconfigured One"), { ...scoped, temporaryDirectory: "" }),
      /Temporary directory is required/,
    );
    assert.throws(
      () => prepareDownload(
        { ...source("Unconfigured Explicit"), temporaryDirectory: join(testRoot, "tmp") },
        { ...scoped, temporaryDirectory: "" },
      ),
      /not configured/,
    );

    // Job creation uses the same fallback end to end.
    const job = createJob(source("Fallback Job"), ownerA, scoped);
    assert.equal(job.temporaryDirectory, resolve(join(testRoot, "tmp")));
  });

  test("archive scan persists SHA-256 checksums, skips unchanged files, and repairs legacy rows", async () => {
    const libraryDirectory = join(testRoot, "checksum-library");
    const downloadDirectory = join(testRoot, "checksum-downloads");
    const counterFile = join(testRoot, "checksum-probe-count.log");
    const ffprobePath = join(testRoot, "counting-ffprobe.mjs");
    await mkdir(libraryDirectory, { recursive: true });
    await mkdir(downloadDirectory, { recursive: true });
    await writeFile(ffprobePath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const file = process.argv.at(-1) ?? "";
appendFileSync(${JSON.stringify(counterFile)}, file + "\\n");
process.stdout.write(JSON.stringify({
  format: { duration: "100.5", format_name: "matroska,webm" },
  streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }],
}));`);
    await chmod(ffprobePath, 0o755);

    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    const files = {
      first: join(libraryDirectory, "First.Feature.mkv"),
      second: join(libraryDirectory, "Second.Feature.mkv"),
      dupOne: join(downloadDirectory, "Dup.One.mkv"),
      dupTwo: join(downloadDirectory, "Dup.Two.mkv"),
    };
    await writeFile(files.first, "first-feature-content");
    await writeFile(files.second, "second-feature-content");
    await writeFile(files.dupOne, "same-bytes");
    await writeFile(files.dupTwo, "same-bytes");
    // Dup.Two starts out recorded the way older builds recorded it: active
    // row, real stats, but no checksum. The scan must repair exactly that.
    const legacyStats = await stat(files.dupTwo);
    archiveDb.prepare(`
      INSERT INTO file_record (path, owner_id, scan_status, size_bytes, modified_at_ms, checksum)
      VALUES (?, ?, 'active', ?, ?, NULL)
    `).run(files.dupTwo, ownerA, legacyStats.size, Math.trunc(legacyStats.mtimeMs));

    writeSettings({ archiveDirectory: libraryDirectory, downloadDirectory, ffprobePath });

    const waitForScan = async (ownerId: string) => {
      startArchiveScan(ownerId);
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const state = readArchiveScan(ownerId);
        if (state.status !== "scanning") return state;
        await new Promise((resolveScan) => setTimeout(resolveScan, 10));
      }
      throw new Error("Archive scan did not finish.");
    };
    const probeCount = async () => {
      try {
        return (await readFile(counterFile, "utf8")).trim().split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    };

    const firstScan = await waitForScan(ownerA);
    assert.equal(firstScan.status, "completed");
    assert.equal(firstScan.scannedFiles, 4);
    assert.equal(firstScan.failedFiles, 0);
    assert.equal(await probeCount(), 4, "every discovered file should be probed once on first scan");

    let inventory = readArchiveInventory(ownerA);
    const recordOf = (filename: string) => inventory.records.find((record) => record.filename === filename);
    assert.equal(recordOf("First.Feature.mkv")?.checksum, sha256("first-feature-content"));
    assert.equal(recordOf("Second.Feature.mkv")?.checksum, sha256("second-feature-content"));
    assert.equal(recordOf("Dup.One.mkv")?.checksum, sha256("same-bytes"));
    assert.equal(recordOf("Dup.Two.mkv")?.checksum, sha256("same-bytes"), "legacy null-checksum rows are repaired on the next scan");
    const ownNames = ["First.Feature.mkv", "Second.Feature.mkv", "Dup.One.mkv", "Dup.Two.mkv"];
    const duplicates = inventory.records
      .filter((record) => ownNames.includes(record.filename) && record.qualityStatus === "duplicate")
      .map((record) => record.filename)
      .sort();
    assert.deepEqual(duplicates, ["Dup.One.mkv", "Dup.Two.mkv"], "checksum equality marks both byte-identical copies");

    // Re-scanning unchanged files must neither spawn ffprobe nor re-read the
    // bytes for hashing; the stored checksum is the durable duplicate evidence.
    const secondScan = await waitForScan(ownerA);
    assert.equal(secondScan.status, "completed");
    assert.equal(await probeCount(), 4, "unchanged files must not be re-inspected or re-hashed");
    inventory = readArchiveInventory(ownerA);
    assert.equal(recordOf("Dup.One.mkv")?.checksum, sha256("same-bytes"));

    // Changing one file's content re-inspects and re-hashes that file only.
    await writeFile(files.dupOne, "same-bytes-extended");
    const thirdScan = await waitForScan(ownerA);
    assert.equal(thirdScan.status, "completed");
    assert.equal(await probeCount(), 5, "only the changed file is probed again");
    inventory = readArchiveInventory(ownerA);
    assert.equal(recordOf("Dup.One.mkv")?.checksum, sha256("same-bytes-extended"));
    assert.equal(recordOf("Dup.Two.mkv")?.checksum, sha256("same-bytes"));
    assert.equal(recordOf("Dup.One.mkv")?.qualityStatus, "local_only", "the checksum pair no longer matches after the edit");
    assert.equal(recordOf("Dup.Two.mkv")?.qualityStatus, "local_only");
  });

  test("archive operations confine paths, refuse overwrites, journal failures, and roll back", async () => {
    const opsRoot = join(testRoot, "ops-volume");
    await mkdir(opsRoot, { recursive: true });
    writeSettings({
      archiveDirectory: opsRoot,
      downloadDirectory: "",
      temporaryDirectory: join(testRoot, "tmp"),
    });

    const missing = async (candidate: string) => access(candidate).then(() => false, () => true);
    const opById = (id: number) => readOperations(ownerA, 100).find((entry) => entry.id === id);

    // --- path safety matrix -------------------------------------------------
    assert.throws(
      () => validateMutationPaths(join(opsRoot, "inside.mkv"), join(testRoot, "outside.mkv")),
      /not inside a configured archive volume/,
    );
    // Raw ".." segments are rejected before any path normalization happens.
    assert.throws(
      () => validateMutationPaths(`${opsRoot}/../escape.mkv`, join(opsRoot, "target.mkv")),
      /traversal segments/,
    );
    // Normalized escapes are caught by volume containment as a second layer.
    assert.throws(
      () => validateMutationPaths(join(opsRoot, "..", "escape.mkv"), join(opsRoot, "target.mkv")),
      /not inside a configured archive volume/,
    );
    assert.throws(
      () => validateMutationPaths("relative/path.mkv", join(opsRoot, "target.mkv")),
      /must be absolute/,
    );
    assert.throws(
      () => validateMutationPaths(join(opsRoot, "clip.mkv"), join(opsRoot, "clip.txt")),
      /extensions/,
    );
    assert.throws(
      () => validateMutationPaths(join(opsRoot, "same.mkv"), join(opsRoot, "same.mkv")),
      /identical/,
    );

    const source = join(opsRoot, "Old Name.mkv");
    const target = join(opsRoot, "Renamed.mkv");
    await writeFile(source, "payload-one");

    // --- stale source is refused, and the failure is journaled ---------------
    let stats = await stat(source);
    const staleOp = createOperation(ownerA, {
      kind: "rename",
      sourcePath: source,
      targetPath: target,
      fileRecordId: null,
      sourceEvidenceKey: "evidence-stale",
      proposalEvidence: { patternId: "manual-test" },
      expectedSizeBytes: stats.size,
      expectedModifiedAtMs: Math.trunc(stats.mtimeMs),
    });
    assert.ok(staleOp && staleOp.status === "queued");
    await writeFile(source, "payload-one-with-extra-bytes");
    await assert.rejects(() => executeOperation(ownerA, staleOp!.id), /size changed/);
    assert.equal(opById(staleOp!.id)?.status, "failed");
    assert.match(opById(staleOp!.id)?.error ?? "", /not executed/);
    assert.equal(await missing(source), false, "a refused operation never moves the source");

    // --- armed again, the rename succeeds ----------------------------------
    await writeFile(source, "payload-one");
    stats = await stat(source);
    archiveDb.prepare(
      "UPDATE archive_operation SET status = 'queued', error = NULL, expected_size_bytes = ?, expected_modified_at_ms = ? WHERE id = ? AND owner_id = ?",
    ).run(stats.size, Math.trunc(stats.mtimeMs), staleOp!.id, ownerA);
    const executed = await executeOperation(ownerA, staleOp!.id);
    assert.equal(executed?.status, "succeeded");
    assert.equal(await missing(source), true);
    assert.equal(await missing(target), false);
    assert.ok(executed?.appliedAt, "success records when the change applied");

    // --- collision at execution time refuses to overwrite --------------------
    const collisionSource = join(opsRoot, "Collision.mkv");
    const collisionTarget = join(opsRoot, "Collision-Taken.mkv");
    await writeFile(collisionSource, "collision-payload");
    await writeFile(collisionTarget, "occupant");
    const collisionOp = createOperation(ownerA, {
      kind: "rename",
      sourcePath: collisionSource,
      targetPath: collisionTarget,
      fileRecordId: null,
      sourceEvidenceKey: "evidence-collision",
      proposalEvidence: {},
      expectedSizeBytes: null,
      expectedModifiedAtMs: null,
    });
    await assert.rejects(() => executeOperation(ownerA, collisionOp!.id), /nothing was overwritten/);
    assert.equal(opById(collisionOp!.id)?.status, "failed");
    assert.equal(await missing(collisionSource), false, "a blocked collision leaves both files alone");
    assert.equal(await readFile(collisionTarget, "utf8"), "occupant");
    await unlink(collisionTarget);

    // --- rollback restores the original path --------------------------------
    const rolledBack = await rollbackOperation(ownerA, staleOp!.id);
    assert.equal(rolledBack?.status, "rolled_back");
    assert.equal(await missing(target), true);
    assert.equal(await missing(source), false);
    await assert.rejects(() => rollbackOperation(ownerA, staleOp!.id), /cannot be rolled back/);

    // --- restructure creates only in-volume directories, and cleans them up --
    const deepTarget = join(opsRoot, "Created", "Deep", "Renamed.mkv");
    stats = await stat(source);
    const deepOp = createOperation(ownerA, {
      kind: "restructure",
      sourcePath: source,
      targetPath: deepTarget,
      fileRecordId: null,
      sourceEvidenceKey: "evidence-deep",
      proposalEvidence: {},
      expectedSizeBytes: stats.size,
      expectedModifiedAtMs: Math.trunc(stats.mtimeMs),
    });
    const deepExecuted = await executeOperation(ownerA, deepOp!.id);
    assert.equal(deepExecuted?.status, "succeeded");
    assert.ok(deepExecuted && deepExecuted.createdDirectories.includes(join(opsRoot, "Created")));
    assert.ok(deepExecuted && deepExecuted.createdDirectories.includes(join(opsRoot, "Created", "Deep")));
    const deepRollback = await rollbackOperation(ownerA, deepOp!.id);
    assert.equal(deepRollback?.status, "rolled_back");
    assert.equal(await missing(join(opsRoot, "Created")), true, "empty directories created for the move are removed by rollback");

    // --- move kind + rollback that is impossible now stays journaled --------
    const moveSource = join(opsRoot, "Move Me.mkv");
    const moveTarget = join(opsRoot, "Moved", "Move Me.mkv");
    await writeFile(moveSource, "move-payload");
    const moveOp = createOperation(ownerA, {
      kind: "move",
      sourcePath: moveSource,
      targetPath: moveTarget,
      fileRecordId: null,
      sourceEvidenceKey: "evidence-move",
      proposalEvidence: {},
      expectedSizeBytes: null,
      expectedModifiedAtMs: null,
    });
    assert.equal((await executeOperation(ownerA, moveOp!.id))?.status, "succeeded");
    await unlink(moveTarget);
    await assert.rejects(() => rollbackOperation(ownerA, moveOp!.id), /no longer exists at its recorded destination/);
    assert.equal(opById(moveOp!.id)?.status, "succeeded", "a failed rollback attempt leaves the journal truthful");
    assert.match(opById(moveOp!.id)?.error ?? "", /Rollback failed/);

    // --- missing sources fail cleanly -----------------------------------------
    const ghostOp = createOperation(ownerA, {
      kind: "move",
      sourcePath: join(opsRoot, "Ghost.mkv"),
      targetPath: join(opsRoot, "Ghost-Moved.mkv"),
      fileRecordId: null,
      sourceEvidenceKey: null,
      proposalEvidence: {},
      expectedSizeBytes: null,
      expectedModifiedAtMs: null,
    });
    await assert.rejects(() => executeOperation(ownerA, ghostOp!.id), /Source file does not exist/);
    assert.equal(opById(ghostOp!.id)?.status, "failed");

    // --- owner isolation -------------------------------------------------------
    assert.deepEqual(readOperations(ownerB), []);
    await assert.rejects(() => rollbackOperation(ownerB, moveOp!.id), /not found/);
    await assert.rejects(() => executeOperation(ownerB, moveOp!.id), /not found/);

    // The operation kind enum rejects nothing else: sanity-check the error class.
    assert.ok(new ArchiveMutationError("collision", "x") instanceof Error);
  });

  test("naming proposals persist evidence-bound decisions, reopen on evidence change, and apply through the journal", async () => {
    const tvVolume = join(testRoot, "naming-volume", "Tv Shows");
    // "Some Show S1" normalizes to "some show": the destination directory then
    // differs from the source in more than case, so the engine classifies the
    // proposal as a true restructure rather than an in-place rename.
    const showDirectory = join(tvVolume, "Some Show S1", "Season 01");
    await mkdir(showDirectory, { recursive: true });
    const ffprobePath = join(testRoot, "naming-ffprobe.mjs");
    await writeFile(ffprobePath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  format: { duration: "1234.5", format_name: "matroska,webm" },
  streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }],
}));`);
    await chmod(ffprobePath, 0o755);
    const episodeFile = join(showDirectory, "01 - Cold Open.mkv");
    await writeFile(episodeFile, "pilot-master");
    await writeFile(join(tvVolume, "Unrelated File.mkv"), "unrelated");
    writeSettings({ archiveDirectory: tvVolume, downloadDirectory: "", ffprobePath });

    const missing = async (candidate: string) => access(candidate).then(() => false, () => true);
    // Tests share one database; journal assertions count deltas from a baseline.
    const journalLength = () => readOperations(ownerA, 100).length;
    const waitForScan = async (ownerId: string) => {
      startArchiveScan(ownerId);
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const state = readArchiveScan(ownerId);
        if (state.status !== "scanning") return state;
        await new Promise((resolveScan) => setTimeout(resolveScan, 10));
      }
      throw new Error("Archive scan did not finish.");
    };
    assert.equal((await waitForScan(ownerA)).status, "completed");

    const naming = await readNamingProposals(ownerA);
    const proposal = naming.results.find((entry) => entry.sourceFilename === "01 - Cold Open.mkv");
    assert.ok(proposal, "the directory-backed episode should produce a proposal");
    assert.equal(proposal.patternId, "directory_show_season_episode_number");
    assert.equal(proposal.confidence, "high");
    assert.equal(proposal.operation, "restructure");
    assert.equal(proposal.decisionStatus, "unreviewed");
    assert.equal(proposal.decisionStale, false);
    assert.ok(typeof proposal.proposedPath === "string" && proposal.proposedPath.includes(join("some show", "Season 01")));
    const proposedPath = proposal.proposedPath as string;

    // --- apply gates before any acceptance ------------------------------------
    const baseline = journalLength();
    const gated = await applyNamingProposals(ownerA, [proposal.fileRecordId]);
    assert.equal(gated.results[0]?.success, false);
    assert.match(gated.results[0]?.error ?? "", /must be accepted/);
    assert.equal(gated.results[0]?.operation, null, "a gated item never reaches the journal");

    const badAccept = await setNamingProposalDecisions(ownerA, [{ fileRecordId: -1, status: "accepted" }]);
    assert.equal(badAccept.results[0]?.success, false, "unknown records are rejected per item");

    // --- durable decision -------------------------------------------------------
    const decision = await setNamingProposalDecisions(ownerA, [
      { fileRecordId: proposal.fileRecordId, status: "accepted", note: "tidy up S1" },
    ]);
    assert.equal(decision.succeeded, 1);
    const afterDecision = await readNamingProposals(ownerA);
    const acceptedRow = afterDecision.results.find((entry) => entry.fileRecordId === proposal.fileRecordId);
    assert.equal(acceptedRow?.decisionStatus, "accepted");
    assert.equal(acceptedRow?.decisionNote, "tidy up S1");
    assert.equal(acceptedRow?.decisionStale, false);
    assert.equal(afterDecision.summary.acceptedCount, 1);
    const storedDecision = archiveDb.prepare(
      "SELECT status, note FROM naming_proposal_decision WHERE owner_id = ? AND file_record_id = ?",
    ).get(ownerA, proposal.fileRecordId) as { status: string; note: string | null };
    assert.equal(storedDecision.status, "accepted");
    assert.equal(storedDecision.note, "tidy up S1");

    // --- dry run reports the plan but touches nothing ---------------------------
    const dryRun = await applyNamingProposals(ownerA, [proposal.fileRecordId], { dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.results[0]?.success, true);
    assert.equal(dryRun.results[0]?.plan?.ok, true);
    assert.deepEqual(
      (dryRun.results[0]?.plan?.checks ?? []).map((check: { step: string }) => check.step),
      ["path_safety", "source", "collision", "directories"],
    );
    assert.equal(journalLength(), baseline, "a dry run writes no journal rows");
    assert.equal(await missing(episodeFile), false, "a dry run moves no files");

    // --- collision re-checked at apply time -------------------------------------
    await mkdir(dirname(resolve(proposedPath)), { recursive: true });
    await writeFile(proposedPath, "occupant");
    const blocked = await applyNamingProposals(ownerA, [proposal.fileRecordId]);
    assert.equal(blocked.results[0]?.success, false);
    assert.match(blocked.results[0]?.error ?? "", /overwritten/);
    const blockedOperations = readOperations(ownerA, 100);
    assert.equal(blockedOperations.length, baseline + 1, "the attempt is audited even though it failed");
    assert.equal(blockedOperations[0]?.status, "failed");
    assert.equal(await missing(episodeFile), false, "the source stays untouched on collision");
    await unlink(proposedPath);

    // --- apply -------------------------------------------------------------------
    const applied = await applyNamingProposals(ownerA, [proposal.fileRecordId]);
    assert.equal(applied.requested, 1);
    assert.equal(applied.succeeded, 1);
    const appliedOperation = applied.results[0]?.operation;
    assert.ok(appliedOperation);
    assert.equal(appliedOperation?.status, "succeeded");
    assert.equal(appliedOperation?.kind, "restructure");
    assert.equal(await missing(episodeFile), true, "the source path is vacated");
    assert.equal(await missing(appliedOperation!.targetPath), false, "the target now holds the file");
    assert.equal(
      (archiveDb.prepare("SELECT path FROM file_record WHERE owner_id = ? AND id = ?").get(ownerA, proposal.fileRecordId) as { path: string }).path,
      appliedOperation!.targetPath,
      "the inventory row follows the move so the archive stays truthful",
    );

    // --- rollback through the journal --------------------------------------------
    const rolledBack = await rollbackOperation(ownerA, appliedOperation!.id);
    assert.equal(rolledBack?.status, "rolled_back");
    assert.equal(await missing(episodeFile), false);
    assert.equal(await missing(appliedOperation!.targetPath), true);

    // --- evidence change reopens an accepted proposal ------------------------------
    await setNamingProposalDecisions(ownerA, [{ fileRecordId: proposal.fileRecordId, status: "accepted" }]);
    await writeFile(episodeFile, "pilot-master-remuxed");
    assert.equal((await waitForScan(ownerA)).status, "completed");
    const reopened = await readNamingProposals(ownerA);
    const reopenedProposal = reopened.results.find((entry) => entry.fileRecordId === proposal.fileRecordId);
    assert.equal(reopenedProposal?.decisionStatus, "unreviewed", "changed evidence reopens the proposal for review");
    assert.equal(reopenedProposal?.decisionStale, true);
    assert.equal(reopened.summary.acceptedCount, 0);
    assert.equal(reopened.summary.staleDecisionCount, 1);
    const reopenBlocked = await applyNamingProposals(ownerA, [proposal.fileRecordId]);
    assert.match(reopenBlocked.results[0]?.error ?? "", /superseded evidence/);

    // deferred/rejected remain expressible on the reopened proposal
    const deferred = await setNamingProposalDecisions(ownerA, [{ fileRecordId: proposal.fileRecordId, status: "deferred" }]);
    assert.equal(deferred.results[0]?.success, true);
    const deferredView = await readNamingProposals(ownerA);
    assert.equal(deferredView.results.find((entry) => entry.fileRecordId === proposal.fileRecordId)?.decisionStatus, "deferred");
    assert.equal(deferredView.summary.deferredCount, 1);
    const rejectedView = await setNamingProposalDecisions(ownerA, [{ fileRecordId: proposal.fileRecordId, status: "rejected" }]);
    assert.equal(rejectedView.results[0]?.success, true);
    assert.equal(
      (await readNamingProposals(ownerA)).results.find((entry) => entry.fileRecordId === proposal.fileRecordId)?.decisionStatus,
      "rejected",
    );

    // --- bounded batch -----------------------------------------------------------
    await assert.rejects(
      () => applyNamingProposals(ownerA, Array.from({ length: 26 }, (_, index) => index + 1)),
      /limited to 25/,
    );

    // --- owner isolation ------------------------------------------------------------
    assert.equal((await readNamingProposals(ownerB)).results.length, 0);
    const crossOwnerDecision = await setNamingProposalDecisions(ownerB, [{ fileRecordId: proposal.fileRecordId, status: "accepted" }]);
    assert.equal(crossOwnerDecision.results[0]?.success, false, "other owners cannot decide on this archive");
    const crossOwnerApply = await applyNamingProposals(ownerB, [proposal.fileRecordId]);
    assert.match(crossOwnerApply.results[0]?.error ?? "", /No current naming proposal/);
    assert.deepEqual(readOperations(ownerB), [], "journal rows are owner-scoped");
  });
});