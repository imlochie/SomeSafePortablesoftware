import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  LEGACY_OWNER_ID,
  addEvent,
  archiveDb,
  claimLegacyData,
  readEvents,
  readSettings,
  readUserSetting,
  writeUserSetting,
} from "../src/lib/archive-db";
import {
  cancelJob,
  createJob,
  readJobs,
  subscribeDownloadEvents,
} from "../src/services/download-engine";

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
});