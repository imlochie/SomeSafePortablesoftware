/**
 * Tests for archive intake: the URL -> Archive seam.
 *
 * These exercise the real promotion path end to end, but only ever against
 * disposable directories under `ARCHIVE_TEST_ROOT`. Fixtures are small text
 * files with a media extension; the scanning pipeline is pointed at an FFprobe
 * stub so quality is parsed from deterministic JSON instead of real media.
 *
 * What the suite is protecting:
 * - intake is read-only until an operator asks for a plan;
 * - a blocked promotion stays blocked with the journal's own reason, instead of
 *   being completed through a second, less safe rename path;
 * - promotion goes through the journaled operation machinery, so it carries
 *   evidence, refuses to overwrite, and can be rolled back;
 * - everything an item reports comes from the subsystem that owns it (checksum,
 *   quality verdict, duplicate copy, naming proposal, acquisition need).
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { join } from "node:path";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { archiveDb, LEGACY_OWNER_ID, writeSettings } from "../src/lib/archive-db";
import { runtimeConfig } from "../src/lib/runtime-config";
import { invalidateArchiveInventoryCache, readArchiveInventory, readArchiveScan, startArchiveScan } from "../src/services/archive";
import {
  applyIntakePromotion,
  planIntakePromotion,
  readIntakeItems,
} from "../src/services/archive-intake";
import { readOperations, rollbackOperation } from "../src/services/archive-operations";

const ownerA = runtimeConfig.localOwnerId;
const ownerB = "user-intake-b";
const testRoot = process.env.ARCHIVE_TEST_ROOT;

if (!testRoot) throw new Error("ARCHIVE_TEST_ROOT is required.");

after(() => archiveDb.close());

type JobFixture = {
  owner: string;
  title: string;
  status?: string;
  verification?: string;
  stagedPath: string | null;
  destinationDirectory?: string;
  finalFilename?: string;
  temporaryDirectory?: string;
};

function insertJob(fixture: JobFixture) {
  const columns: Record<string, unknown> = {
    owner_id: fixture.owner,
    url: "https://example.test/watch/abcdef",
    source_url: "https://example.test/watch/abcdef",
    source_site: "example.test",
    title: fixture.title,
    status: fixture.status ?? "complete",
    verification: fixture.verification ?? "passed",
    current_phase: fixture.status ?? "complete",
    progress: 100,
    output_container: "mkv",
    selected_format_id: "best",
    temporary_directory: fixture.temporaryDirectory ?? "",
    destination_directory: fixture.destinationDirectory ?? "",
    final_filename: fixture.finalFilename ?? "download.mkv",
    final_path: fixture.stagedPath,
    completed_at: new Date().toISOString(),
  };
  const keys = Object.keys(columns);
  const result = archiveDb
    .prepare(
      `INSERT INTO download_job (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    )
    .run(...keys.map((key) => columns[key] as string | number | null));
  return Number(result.lastInsertRowid);
}

/** Deterministic probe: the scanner and intake read quality from it. */
async function writeProbeStub(path: string) {
  await writeFile(
    path,
    `#!/usr/bin/env node
// Key on the basename only: the temp root's random suffix can contain letters
// that look like a marker if the whole path is matched.
const file = (process.argv.at(-1) ?? "").split("/").pop() ?? "";
const uhd = /2160p|uhd_import/i.test(file);
process.stdout.write(JSON.stringify({
  format: { duration: "3600.5", format_name: "matroska,webm", bit_rate: uhd ? "60000" : "8000", size: "4096" },
  streams: [
    uhd
      ? { codec_type: "video", codec_name: "hevc", width: 3840, height: 2160, pix_fmt: "yuv420p10le", color_transfer: "smpte2084", bit_depth: 10, r_frame_rate: "24000/1001" }
      : { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p", r_frame_rate: "24000/1001" },
    { codec_type: "audio", codec_name: "aac", channels: 2, channel_layout: "stereo", language: "eng" },
  ],
}));`,
  );
  await chmod(path, 0o755);
}

async function waitForScan(ownerId: string) {
  startArchiveScan(ownerId);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = readArchiveScan(ownerId);
    if (state.status !== "scanning") return state;
    await new Promise((resolveScan) => setTimeout(resolveScan, 10));
  }
  throw new Error("Archive scan did not finish.");
}

describe("archive intake for finished downloads", { concurrency: false }, () => {
  const probe = join(testRoot, "ffprobe-intake.mjs");

  before(async () => {
    await writeProbeStub(probe);
  });

  test("a staged download is inventoried, explained, and refused by the journal rather than renamed directly", async () => {
    const library = join(testRoot, "single-volume", "library");
    const staging = join(testRoot, "single-volume", "staging");
    const temp = join(testRoot, "single-volume", "tmp");
    await mkdir(join(library, "Movies"), { recursive: true });
    await mkdir(staging, { recursive: true });
    await mkdir(temp, { recursive: true });

    const stagedPath = join(staging, "Season.Twelve.2024.1080p.mkv");
    await writeFile(stagedPath, "intake-bytes-one");
    const destination = join(library, "Movies", "Season Twelve (2024)");
    const jobId = insertJob({
      owner: ownerA,
      title: "Season Twelve",
      stagedPath,
      destinationDirectory: destination,
      finalFilename: "Season Twelve (2024).mkv",
      temporaryDirectory: temp,
    });

    writeSettings({
      archiveDirectory: library,
      downloadDirectory: staging,
      temporaryDirectory: temp,
      ffprobePath: probe,
    });
    await waitForScan(ownerA);

    const { items, summary } = await readIntakeItems(ownerA);
    const item = items.find((candidate) => candidate.jobId === jobId);
    assert.ok(item, "the finished download should be on the intake queue");
    assert.equal(item.fileExists, true);
    assert.ok(item.fileRecordId, "the staged file should be inventoried by the scan");
    assert.equal(item.checksumStatus, "computed");
    assert.equal(item.checksum?.length, 64, "intake reports the scanner's checksum");
    assert.equal(item.insideArchiveVolume, false);
    assert.equal(item.disposition, "blocked");
    assert.equal(item.gate.code, "outside_volume");
    assert.match(item.nextAction, /archive volume/);
    // The quality verdict comes from the findings layer, not from intake itself.
    assert.match(item.qualitySummary ?? "", /1080p/);
    assert.match(item.qualitySummary ?? "", /h264/i);
    assert.doesNotMatch(item.qualitySummary ?? "", /HDR/i);
    assert.equal(summary.blocked, 1);

    await assert.rejects(
      () => planIntakePromotion(ownerA, jobId),
      /intake|volume|blocked|state/i,
      "a blocked item must not be plannable",
    );
    assert.deepEqual(readOperations(ownerA), [], "planning a blocked item must not journal anything");
  });

  test("a byte-identical copy already in the archive wins over promotion", async () => {
    const root = join(testRoot, "duplicate");
    const library = join(root, "library");
    const staging = join(root, "staging");
    await mkdir(join(library, "Movies"), { recursive: true });
    await mkdir(staging, { recursive: true });

    const bytes = "identical-media-bytes";
    const heldCopy = join(library, "Movies", "Kept.Episode.2024.1080p.mkv");
    const stagedPath = join(staging, "Kept.Episode.2024.1080p.duplicate.mkv");
    await writeFile(heldCopy, bytes);
    await writeFile(stagedPath, bytes);

    const jobId = insertJob({
      owner: ownerA,
      title: "Kept Episode",
      stagedPath,
      destinationDirectory: join(library, "Movies", "Kept Episode (2024)"),
      finalFilename: "Kept Episode (2024).mkv",
      temporaryDirectory: staging,
    });

    writeSettings({ archiveDirectory: library, downloadDirectory: staging, ffprobePath: probe });
    await waitForScan(ownerA);

    const { items } = await readIntakeItems(ownerA);
    const item = items.find((candidate) => candidate.jobId === jobId);
    assert.ok(item);
    assert.equal(item.disposition, "already_in_archive");
    assert.equal(item.duplicates.length, 1);
    assert.equal(item.duplicates[0]?.exact, true);
    assert.equal(item.duplicates[0]?.path, heldCopy);
    assert.match(item.nextAction, /duplicate/i);
    await assert.rejects(() => planIntakePromotion(ownerA, jobId));
    // Intake only ever reads, so the file the operator already owns is untouched.
    assert.equal(await readFile(heldCopy, "utf8"), bytes);
    assert.equal(await readFile(stagedPath, "utf8"), bytes);
  });

  test("promotion moves the staged file through the journal and can be rolled back", async () => {
    const root = join(testRoot, "promotable");
    const library = join(root, "library");
    const staging = join(root, "staging");
    await mkdir(join(library, "Movies"), { recursive: true });
    await mkdir(staging, { recursive: true });

    const stagedPath = join(staging, "Uhd.Imports.2024.2160p.mkv");
    await writeFile(stagedPath, "promotable-4k-bytes");
    const destination = join(library, "Movies", "UHD Imports (2024)");
    const targetPath = join(destination, "UHD Imports (2024).mkv");
    const jobId = insertJob({
      owner: ownerA,
      title: "UHD Imports",
      stagedPath,
      destinationDirectory: destination,
      finalFilename: "UHD Imports (2024).mkv",
      temporaryDirectory: staging,
    });

    // Two archive volumes: the library and the staging directory. With the
    // staging directory inside the journal's containment rules, the move becomes
    // a validation-eligible mutation instead of a raw rename.
    writeSettings({
      archiveDirectory: `${library}\n${staging}`,
      downloadDirectory: staging,
      ffprobePath: probe,
    });
    await waitForScan(ownerA);

    const before = await readIntakeItems(ownerA);
    const item = before.items.find((candidate) => candidate.jobId === jobId);
    assert.ok(item);
    assert.equal(item.disposition, "promotable");
    assert.equal(item.proposedTargetPath, targetPath);
    assert.equal(item.insideArchiveVolume, true);

    const planned = await planIntakePromotion(ownerA, jobId);
    assert.equal(planned.operation?.status, "proposed", "planning must not execute anything");
    assert.equal(planned.operation?.kind, "move");
    assert.equal(planned.operation?.expectedSizeBytes, (await stat(stagedPath)).size);
    assert.equal(planned.plan?.ok, true);
    assert.equal(planned.planError, null);
    assert.ok((await stat(stagedPath)).size > 0, "the file stays put until it is applied");

    const applied = await applyIntakePromotion(ownerA, jobId, planned.operation?.id ?? -1);
    assert.equal(applied.operation?.status, "succeeded");
    assert.equal(applied.operation?.targetPath, targetPath);
    assert.equal(
      applied.item?.disposition,
      "already_in_archive",
      "after promotion the queue reports the archive path, not an empty staging slot",
    );
    assert.match(applied.item?.nextAction ?? "", /Already promoted/);

    const moved = await readFile(targetPath, "utf8");
    assert.equal(moved, "promotable-4k-bytes");
    await assert.rejects(() => stat(stagedPath), "the file must not be duplicated by intake");

    // The archive record followed the file, so inventory and quality stay true.
    invalidateArchiveInventoryCache(ownerA);
    const inventory = readArchiveInventory(ownerA);
    const promoted = inventory.records.find((record) => record.path === targetPath);
    assert.ok(promoted, "the relocated record should carry the new path");
    assert.equal(promoted.height, 2160, "the promoted file keeps its parsed quality");

    const rolledBack = await rollbackOperation(ownerA, planned.operation?.id ?? -1);
    assert.equal(rolledBack?.status, "rolled_back");
    assert.equal(await readFile(stagedPath, "utf8"), "promotable-4k-bytes");
    assert.deepEqual(
      (await readOperations(ownerA, 50)).filter((entry) => entry.id === planned.operation?.id)[0]?.status,
      "rolled_back",
    );
  });

  test("promotion refuses when the staged file changed after planning", async () => {
    const root = join(testRoot, "stale-plan");
    const library = join(root, "library");
    const staging = join(root, "staging");
    await mkdir(join(library, "Movies"), { recursive: true });
    await mkdir(staging, { recursive: true });

    const stagedPath = join(staging, "Late.Edit.2024.1080p.mkv");
    await writeFile(stagedPath, "original-payload");
    const jobId = insertJob({
      owner: ownerA,
      title: "Late Edit",
      stagedPath,
      destinationDirectory: join(library, "Movies", "Late Edit (2024)"),
      finalFilename: "Late Edit (2024).mkv",
      temporaryDirectory: staging,
    });
    writeSettings({ archiveDirectory: `${library}\n${staging}`, downloadDirectory: staging, ffprobePath: probe });
    await waitForScan(ownerA);

    const planned = await planIntakePromotion(ownerA, jobId);
    // The operator (or a re-download) replaced the bytes after the plan was made.
    await writeFile(stagedPath, "a-completely-different-and-longer-payload");
    invalidateArchiveInventoryCache(ownerA);

    // The journal's own evidence check is what refuses this, and it records the
    // failed attempt rather than silently doing nothing.
    await assert.rejects(
      () => applyIntakePromotion(ownerA, jobId, planned.operation?.id ?? -1),
      /changed since the proposal/i,
      "a stale plan must be refused before the file moves",
    );
    assert.equal(await readFile(stagedPath, "utf8"), "a-completely-different-and-longer-payload");
    const refusal = (await readOperations(ownerA, 50)).find((entry) => entry.id === planned.operation?.id);
    assert.equal(refusal?.status, "failed");
    assert.match(refusal?.error ?? "", /size/i);
  });

  test("mock jobs and other owners never appear as promotable intake", async () => {
    const root = join(testRoot, "missing-and-isolation");
    const library = join(root, "library");
    const staging = join(root, "staging");
    await mkdir(join(library, "Movies"), { recursive: true });
    await mkdir(staging, { recursive: true });

    // The demo engine records a final path it never writes to disk.
    const mockJobId = insertJob({
      owner: ownerA,
      title: "Demo Download",
      stagedPath: join(staging, "Never.Written.2024.1080p.mkv"),
      destinationDirectory: join(library, "Movies", "Demo (2024)"),
      finalFilename: "Demo (2024).mkv",
      temporaryDirectory: staging,
    });
    const otherJobId = insertJob({
      owner: ownerB,
      title: "Someone Else's Download",
      stagedPath: join(staging, "Other.Person.2024.1080p.mkv"),
      destinationDirectory: join(library, "Movies", "Other (2024)"),
      finalFilename: "Other (2024).mkv",
      temporaryDirectory: staging,
    });

    writeSettings({ archiveDirectory: `${library}\n${staging}`, downloadDirectory: staging, ffprobePath: probe });
    await waitForScan(ownerA);
    await waitForScan(ownerB);

    const mine = await readIntakeItems(ownerA);
    const mockItem = mine.items.find((candidate) => candidate.jobId === mockJobId);
    assert.ok(mockItem, "a finished job with no file is still reported, not hidden");
    assert.equal(mockItem.disposition, "file_missing");
    assert.equal(mockItem.fileExists, false);
    assert.equal(mockItem.fileRecordId, null);
    assert.match(mockItem.nextAction, /no file to intake/i);
    await assert.rejects(() => planIntakePromotion(ownerA, mockJobId));

    assert.equal(
      mine.items.some((candidate) => candidate.jobId === otherJobId),
      false,
      "another owner's download must not surface in this owner's queue",
    );
    const theirs = await readIntakeItems(ownerB);
    assert.ok(theirs.items.some((candidate) => candidate.jobId === otherJobId));
    assert.equal(
      theirs.items.every((candidate) => candidate.jobId !== mockJobId),
      true,
      "and vice versa",
    );
  });

  test("intake reads only its owner's data even when legacy rows exist", async () => {
    const root = join(testRoot, "legacy-claim");
    const library = join(root, "library");
    const staging = join(root, "staging");
    await mkdir(join(library, "Movies"), { recursive: true });
    await mkdir(staging, { recursive: true });
    const stagedPath = join(staging, "Legacy.Pickup.2024.1080p.mkv");
    await writeFile(stagedPath, "legacy-payload");
    insertJob({
      owner: LEGACY_OWNER_ID,
      title: "Legacy Pickup",
      stagedPath,
      destinationDirectory: join(library, "Movies", "Legacy Pickup (2024)"),
      finalFilename: "Legacy Pickup (2024).mkv",
      temporaryDirectory: staging,
    });
    writeSettings({ archiveDirectory: `${library}\n${staging}`, downloadDirectory: staging, ffprobePath: probe });
    await waitForScan(ownerB);

    const items = await readIntakeItems(ownerB);
    assert.equal(
      items.items.some((candidate) => candidate.title === "Legacy Pickup"),
      false,
      "unclaimed legacy rows stay invisible until they are claimed",
    );
  });
});
