import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
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
} from "../src/services/archive";

const ownerA = "user-a";
const ownerB = "user-b";
const testRoot = process.env.ARCHIVE_TEST_ROOT;

if (!testRoot) throw new Error("ARCHIVE_TEST_ROOT is required.");

after(() => archiveDb.close());

describe("user ownership", { concurrency: false }, () => {
  test("additive migration preserves existing rows and first user claims them exactly once", () => {
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

    const duplicateRows = inventory.records.filter((record) => record.qualityStatus === "duplicate");
    assert.equal(duplicateRows.length, 2);
    assert.ok(duplicateRows.every((record) => record.qualitySummary.includes("SHA-256")));
    assert.equal(inventory.records.find((record) => record.filename === "Corrupt.mp4")?.scanStatus, "error");
    assert.ok(inventory.plexOnly.some((record) => record.title === "Beta"));
    assert.deepEqual(readArchiveInventory(ownerB).records, []);

    await waitForScan(ownerA);
    assert.equal(readArchiveInventory(ownerA).records.length, 7);
    assert.equal(
      (archiveDb.prepare("SELECT COUNT(*) AS count FROM file_record WHERE owner_id = ?").get(ownerA) as { count: number }).count,
      7,
    );

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
    } finally {
      reopened.close();
    }
  });
});