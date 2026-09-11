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
import {
  applyIntakePromotion,
  planIntakePromotion,
  readIntakeItems,
} from "../src/services/archive-intake";
import { readReconciliationReport } from "../src/services/reconciliation";

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

  test("approval → execution → intake → journaled promotion → archive → reconciliation", async () => {
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

    // 6: bounded batch through the REAL engine (stub binaries).
    const executing = executeAcquisitionPlan(ownerA, plan.id);
    assert.equal(executing.items.length, 2);
    assert.ok(executing.items.every((item) => item.downloadJobId !== null), "each item links to a real download job");
    assert.equal(executing.executionStrategy.batchLimit, 25, "the batch is bounded");

    // Re-execution has nothing more to queue: every item already has a job.
    assert.throws(() => executeAcquisitionPlan(ownerA, plan.id), /Nothing left to execute/i);

    // The real pipeline runs: yt-dlp download → FFmpeg remux → FFprobe verify →
    // the engine's own safe move into the archive volume (at the volume root —
    // the plan's destination is deliberately NOT handed to the engine).
    await waitFor(
      async () => (await readJobs(ownerA)).filter((job) => job.status === "complete").length >= 2,
      "both downloads to complete",
    );

    // A finished download is STAGED, not promoted: the plan's own state machine
    // reports that the verified file waits for the intake gate.
    const staged = readAcquisitionPlan(ownerA, plan.id);
    assert.ok(staged);
    assert.ok(staged.items.every((item) => item.state === "staged"), `items: ${JSON.stringify(staged.items)}`);
    for (const item of staged.items) {
      assert.ok(item.destinationPath?.startsWith(tvVolume), `staged under the TV volume: ${item.destinationPath}`);
      const stagedFile = await stat(item.destinationPath);
      assert.ok(stagedFile.size > 0, "the staged file has content");
    }

    // 7: the completed files pass through intake. The scanner inventories them
    // first, so every judgement intake carries comes from a real subsystem.
    assert.equal((await waitForScan(ownerA)).status, "completed");
    const intake = await readIntakeItems(ownerA);
    const planItems = staged.items;
    const intakeFor = (identityKey: string) => intake.items.find(
      (candidate) => candidate.title === planItems.find((item) => item.identityKey === identityKey)?.title,
    );

    for (const item of planItems) {
      const entry = intakeFor(item.identityKey);
      assert.ok(entry, `intake item exists for ${item.identityKey}`);
      // 8: identity, quality, and naming are verified by their own subsystems.
      assert.ok(entry.fileRecordId, "the staged file is inventoried");
      assert.equal(entry.checksumStatus, "computed");
      assert.equal(entry.verification, "passed");
      assert.ok(entry.checksum && entry.checksum.length === 64);
      assert.match(entry.qualitySummary ?? "", /1080p|2160p/, "quality verdict from the findings layer");
      // The promotion target is the plan's destination, never the naming
      // proposal: intake must not jump the naming queue.
      const expectedTarget = plan.destinationPlan.find((d) => d.identityKey === item.identityKey);
      assert.ok(expectedTarget);
      assert.equal(entry.proposedTargetPath, join(expectedTarget.destinationDirectory, expectedTarget.finalFilename));
      assert.equal(entry.disposition, "promotable");
      assert.equal(entry.gate.legal, true);

      // 9: promotion goes through the safe mutation journal — plan first.
      const plannedPromotion = await planIntakePromotion(ownerA, entry.jobId);
      assert.equal(plannedPromotion.operation?.status, "proposed", "planning must not execute anything");
      assert.equal(plannedPromotion.plan?.ok, true, `dry run: ${plannedPromotion.planError}`);
      const beforeApply = await stat(entry.stagedPath);
      assert.ok(beforeApply.size > 0, "the file stays put until the promotion is applied");

      const applied = await applyIntakePromotion(ownerA, entry.jobId, plannedPromotion.operation?.id ?? -1);
      assert.equal(applied.operation?.status, "succeeded");
      assert.ok(applied.operation?.rollbackAvailable, "promotion is a rollbackable journal operation");
      assert.equal(applied.item?.disposition, "already_in_archive", "the promoted item reports its new home");
      const finalPath = applied.operation?.targetPath as string;
      const finalFile = await stat(finalPath);
      assert.ok(finalFile.size > 0, "the file now lives at its permanent archive path");
      assert.ok(finalPath.startsWith(tvVolume), "the final path is inside the TV volume");
    }

    // The plan's own state machine followed the promotion through the journal.
    const promoted = readAcquisitionPlan(ownerA, plan.id);
    assert.ok(promoted);
    assert.ok(promoted.items.every((item) => item.state === "promoted"), `items: ${JSON.stringify(promoted.items)}`);
    for (const item of promoted.items) {
      const destination = plan.destinationPlan.find((d) => d.identityKey === item.identityKey);
      assert.ok(destination);
      assert.equal(item.destinationPath, join(destination.destinationDirectory, destination.finalFilename));
    }
    // Final results are derived and auditable once every item is terminal.
    assert.ok(promoted.finalResults);
    assert.equal(promoted.finalResults.placedCount, 2);
    assert.equal(promoted.finalResults.failedCount, 0);

    // 10: the archive re-scan re-resolves identity at the final paths.
    assert.equal((await waitForScan(ownerA)).status, "completed");
    const inventory = readArchiveInventory(ownerA);
    const kirraRecords = inventory.records.filter((record) => /kirra/i.test(record.filename));
    assert.equal(kirraRecords.length, 3, "all three episodes are inventoried");
    assert.ok(kirraRecords.every((record) => record.checksum), "checksums persisted for the final files");
    for (const item of promoted.items) {
      assert.ok(inventory.records.some((record) => record.path === item.destinationPath), `inventory holds ${item.destinationPath}`);
    }

    // 11: the final state is exposed to Plex reconciliation with identity.
    const reconciliation = await readReconciliationReport(ownerA);
    const reconciliationRows = reconciliation.results as Array<{
      classification: string;
      local: { path: string; identity: { key?: string; show?: string; season?: number; episode?: number } | null } | null;
    }>;
    for (const item of promoted.items) {
      const row = reconciliationRows.find((candidate) => candidate.local?.path === item.destinationPath);
      assert.ok(row, `reconciliation exposes the promoted file ${item.destinationPath}`);
      assert.ok(
        row.local?.identity && (row.local.identity.key === item.identityKey || row.local.identity.show !== undefined),
        `reconciliation carries the identity for ${item.identityKey}`,
      );
    }

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
