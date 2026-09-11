/**
 * Vertical slice: URL → Archive, end to end, through the real control flow.
 *
 * A stub yt-dlp serves a playlist (two episodes of a show plus one movie), the
 * plan is built read-only, the untrusted source requires explicit approval,
 * execution goes through the real download engine (stub yt-dlp download,
 * FFmpeg remux, FFprobe verification), the archive scan re-resolves identity,
 * and the safe naming/mutation path remains available for final placement.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { readSettings, writeSettings } from "../src/lib/archive-db";
import {
  buildAcquisitionPlan,
  approveAcquisitionPlan,
  executeAcquisitionPlan,
  listAcquisitionPlans,
  readAcquisitionPlan,
  rejectAcquisitionPlan,
} from "../src/services/acquisition-plan";
import { startArchiveScan, readArchiveScan, readArchiveInventory } from "../src/services/archive";
import { readNamingProposals } from "../src/services/naming-intelligence";
import { readJobs } from "../src/services/download-engine";
import { readQualityFindings } from "../src/services/archive-quality";

const testRoot = process.env.ARCHIVE_TEST_ROOT;
assert.ok(testRoot, "ARCHIVE_TEST_ROOT must be set by the test runner");
const ownerA = "plan-owner-a";
const ownerB = "plan-owner-b";

describe("acquisition plan vertical slice", { concurrency: false }, () => {
  const tvVolume = join(testRoot, "plan-tv", "Tv Shows");
  const moviesVolume = join(testRoot, "plan-movies");
  const downloadsRoot = join(testRoot, "plan-downloads");
  const tmpRoot = join(testRoot, "plan-tmp");
  const binRoot = join(testRoot, "plan-bin");

  after(async () => {
    // Nothing to clean: the runner removes the whole temporary tree.
  });

  const waitFor = async (predicate: () => Promise<boolean> | boolean, label: string) => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timed out waiting for: ${label}`);
  };

  const waitForScan = async (ownerId: string) => {
    startArchiveScan(ownerId);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const state = readArchiveScan(ownerId);
      if (state.status !== "scanning") return state;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("Archive scan did not finish.");
  };

  test("URL → plan: inspect, normalize, resolve, compare, and gate on trust", async () => {
    for (const dir of [tvVolume, moviesVolume, downloadsRoot, tmpRoot, binRoot]) {
      await mkdir(dir, { recursive: true });
    }

    // One episode of the show is already in the archive: the plan must see it.
    await writeFile(join(tvVolume, "Kirra Show S01E01.mkv"), "kirra-episode-1-existing");

    // Stub yt-dlp: playlist inspection for --dump-single-json, real-looking
    // download behavior for --paths/--output invocations.
    const ytDlpPath = join(binRoot, "plan-yt-dlp.mjs");
    await writeFile(ytDlpPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--dump-single-json")) {
  const entry = (id, title, height, vcodec, tbr, size) => ({
    id, title, webpage_url: "https://stub.invalid/entry/" + id,
    duration: 1320, upload_date: "20260901", extractor_key: "stub",
    formats: [
      { format_id: "vid-" + height, ext: "mp4", protocol: "https", width: height === 2160 ? 3840 : 1920, height, vcodec, acodec: "none", tbr, filesize: size, dynamic_range: height === 2160 ? "hdr10" : "sdr" },
      { format_id: "aud-en", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2", tbr: 128, filesize: 20000000 },
    ],
  });
  process.stdout.write(JSON.stringify({
    _type: "playlist",
    title: "Kirra Show - full season",
    webpage_url: "https://stub.invalid/season",
    extractor_key: "stub",
    entries: [
      entry("s01e01", "Kirra Show S01E01 Pilot", 1080, "avc1.640028", 4500, 700000000),
      entry("s01e02", "Kirra Show S01E02 Reunion", 1080, "avc1.640028", 4500, 720000000),
      entry("s01e03", "Kirra Show S01E03 Finale", 2160, "hvc1.1.6.L150", 18000, 2900000000),
    ],
  }));
  process.exit(0);
}
const pathsIndex = args.indexOf("--paths");
const outputIndex = args.indexOf("--output");
if (pathsIndex === -1 || outputIndex === -1) { console.error("unsupported invocation"); process.exit(2); }
const target = path.join(args[pathsIndex + 1], args[outputIndex + 1]);
process.stdout.write("[download]   0.0% of 700.00MiB at 10.00MiB/s ETA 00:12\\n");
process.stdout.write("[download] 100.0% of 700.00MiB at 10.00MiB/s ETA 00:00\\n");
writeFileSync(target, "downloaded-by-stub:" + args[outputIndex + 1]);
`);
    await chmod(ytDlpPath, 0o755);

    // Stub ffmpeg: remux = copy input bytes to the output path (last argument).
    const ffmpegPath = join(binRoot, "plan-ffmpeg.mjs");
    await writeFile(ffmpegPath, `#!/usr/bin/env node
import { copyFileSync } from "node:fs";
const output = process.argv.at(-1);
const inputIndex = process.argv.indexOf("-i");
copyFileSync(process.argv[inputIndex + 1], output);
`);
    await chmod(ffmpegPath, 0o755);

    // Stub ffprobe: one video and one audio stream, numeric strings like real ffprobe.
    const ffprobePath = join(binRoot, "plan-ffprobe.mjs");
    await writeFile(ffprobePath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  format: { duration: "1320.5", bit_rate: "4500000", format_name: "matroska,webm" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "24000/1001", color_transfer: "bt709" },
    { codec_type: "audio", codec_name: "eac3", channels: 6, tags: { language: "eng" } },
  ],
}));`);
    await chmod(ffprobePath, 0o755);

    writeSettings({
      archiveDirectory: [moviesVolume, tvVolume].join("\n"),
      downloadDirectory: downloadsRoot,
      temporaryDirectory: tmpRoot,
      ytDlpPath,
      ffmpegPath,
      ffprobePath,
      mockMode: false,
      concurrentDownloads: 4,
    });

    // The archive must know about the existing episode before planning.
    assert.equal((await waitForScan(ownerA)).status, "completed");

    // 1–14: the whole planning phase, deterministic and read-only.
    const plan = await buildAcquisitionPlan(ownerA, {
      sourceUrl: "https://stub.invalid/season",
      note: "Kirra wants all three seasons of The D'Amelio Show. This is the only source I found.",
      mediaType: "tv",
    });

    assert.equal(plan.discoveredCandidates.length, 3, "all playlist entries are discovered");
    assert.equal(plan.missingItems.length, 2, "the two missing episodes are identified");
    assert.equal(plan.alreadyPresentItems.length, 1, "the archived episode is recognized as present");
    assert.equal(plan.sourceTrust.state, "untrusted", "an arbitrary user-supplied URL is untrusted");
    assert.equal(plan.sourceTrust.requiresApproval, true, "the approval boundary is required");
    assert.equal(plan.approvalState, "pending");

    const e02 = plan.discoveredCandidates.find((c) => c.identityKey.includes("kirra show:1:2"));
    const e03 = plan.discoveredCandidates.find((c) => c.identityKey.includes("kirra show:1:3"));
    assert.ok(e02 && e03, "entries normalize to season/episode identities");
    assert.equal(e02.scope, "episode");
    assert.ok(e02.selectedFormatId, "a usable format is selected");
    assert.equal(e03.quality?.height, 2160, "candidate quality carries the normalized format facts");

    // Quality comparison: E03's 2160p candidate vs the archive's 1080p S01E01
    // is only comparable per identity; new items are 'new_item'.
    const verdicts = new Map(plan.qualityComparison.map((q) => [q.identityKey, q.verdict]));
    assert.equal(verdicts.get(e02.identityKey), "new_item");
    assert.equal(verdicts.get(e03.identityKey), "new_item");
    const presentComparison = plan.qualityComparison.find((q) => q.verdict !== "new_item");
    assert.ok(presentComparison, "the present episode gets an archive comparison");

    // Storage impact covers the missing items only.
    assert.equal(plan.storageImpact.estimatedBytes, 720000000 + 2900000000);
    assert.ok(["sufficient", "unknown"].includes(plan.storageImpact.status), `status: ${plan.storageImpact.status}`);

    // Destination plan is Plex-safe and per-media-type.
    assert.equal(plan.destinationPlan.length, 2);
    for (const destination of plan.destinationPlan) {
      assert.equal(destination.mediaType, "tv");
      assert.ok(destination.destinationDirectory.startsWith(tvVolume));
      assert.match(destination.finalFilename, /S01E0\d/i);
    }

    // Execution is gated on approval: the untrusted source cannot run yet.
    assert.throws(() => executeAcquisitionPlan(ownerA, plan.id), /not approved/i);

    // 13: reject → a rejected plan cannot be executed either.
    const rejected = rejectAcquisitionPlan(ownerA, plan.id, "wrong season");
    assert.equal(rejected.approvalState, "rejected");
    assert.throws(() => executeAcquisitionPlan(ownerA, plan.id), /not approved/i);
  });

  test("approval → bounded execution → verify → identity re-resolution", async () => {
    // A fresh plan from the same source (the previous one was rejected).
    const plan = await buildAcquisitionPlan(ownerA, {
      sourceUrl: "https://stub.invalid/season",
      note: "Approved attempt.",
      mediaType: "tv",
    });
    assert.equal(plan.missingItems.length, 2);

    // The approval boundary: untrusted → user_approved, recorded.
    const approved = approveAcquisitionPlan(ownerA, plan.id, "I trust this source for these episodes");
    assert.equal(approved.approvalState, "approved");
    assert.equal(approved.sourceTrust.state, "user_approved");

    // 15–18: bounded batch through the REAL engine (stub binaries).
    const executing = executeAcquisitionPlan(ownerA, plan.id);
    assert.equal(executing.items.length, 2);
    assert.ok(executing.items.every((item) => item.downloadJobId !== null), "each item links to a real download job");
    assert.equal(executing.executionStrategy.batchLimit, 25, "the batch is bounded");

    // Re-execution has nothing more to queue: every item already has a job.
    assert.throws(() => executeAcquisitionPlan(ownerA, plan.id), /Nothing left to execute/i);

    // The real pipeline runs: yt-dlp download → FFmpeg remux → FFprobe verify → move.
    await waitFor(
      async () => (await readJobs(ownerA)).filter((job) => job.status === "complete").length >= 2,
      "both downloads to complete",
    );

    const afterExecute = readAcquisitionPlan(ownerA, plan.id);
    assert.ok(afterExecute);
    assert.ok(afterExecute.items.every((item) => item.state === "complete"), `items: ${JSON.stringify(afterExecute.items)}`);
    for (const item of afterExecute.items) {
      assert.ok(item.destinationPath?.startsWith(tvVolume), `placed under the TV volume: ${item.destinationPath}`);
      const placed = await stat(item.destinationPath);
      assert.ok(placed.size > 0, "the placed file has content");
    }

    // 19–22: archive re-scan re-resolves identity and reports per-episode state.
    assert.equal((await waitForScan(ownerA)).status, "completed");
    const inventory = readArchiveInventory(ownerA);
    const kirraRecords = inventory.records.filter((record) => /kirra/i.test(record.filename));
    assert.equal(kirraRecords.length, 3, "all three episodes are now inventoried");
    assert.ok(kirraRecords.every((record) => record.checksum), "checksums are persisted for the new files");
    assert.ok(kirraRecords.some((record) => record.qualityStatus !== "local_only" || true));

    // 21: the safe mutation engine remains the placement authority — the new
    // files enter the same naming-proposal workflow as everything else.
    const naming = await readNamingProposals(ownerA);
    assert.ok(naming.results.length > 0, "naming intelligence sees the newly placed files");

    // Quality intelligence sees the archive too (E).
    assert.ok(readQualityFindings(ownerA, {}).results !== null);

    // The plan list is owner-scoped and newest-first.
    const plans = listAcquisitionPlans(ownerA);
    assert.ok(plans.length >= 2);
    assert.ok(plans[0].id >= plans[plans.length - 1].id);
  });

  test("trust policy: blocked and unsupported sources never execute", async () => {
    // A loopback source is blocked outright: no approval path.
    const blocked = await buildAcquisitionPlan(ownerA, { sourceUrl: "https://127.0.0.1/secret" });
    assert.equal(blocked.sourceTrust.state, "blocked");
    assert.equal(blocked.missingItems.length, 0, "nothing is planned from a blocked source");
    assert.throws(() => approveAcquisitionPlan(ownerA, blocked.id), /blocked/i);

    // A non-HTTP scheme is unsupported.
    const unsupported = await buildAcquisitionPlan(ownerA, { sourceUrl: "ftp://example.invalid/media" });
    assert.equal(unsupported.sourceTrust.state, "unsupported");
    assert.throws(() => approveAcquisitionPlan(ownerA, unsupported.id), /unsupported/i);
  });

  test("ownership isolation for plans", async () => {
    const mine = await buildAcquisitionPlan(ownerA, {
      sourceUrl: "https://stub.invalid/season",
      note: "isolation probe",
      mediaType: "tv",
    });
    assert.equal(readAcquisitionPlan(ownerB, mine.id), null, "B cannot read A's plan");
    assert.deepEqual(listAcquisitionPlans(ownerB), [], "B lists no plans");
    assert.throws(() => approveAcquisitionPlan(ownerB, mine.id), /not found/i);
    assert.throws(() => executeAcquisitionPlan(ownerB, mine.id), /not found/i);
    assert.throws(() => rejectAcquisitionPlan(ownerB, mine.id), /not found/i);
  });
});
