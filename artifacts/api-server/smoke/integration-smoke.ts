/**
 * Integration smoke test: one end-to-end pass over the merged subsystems in a
 * fully temporary environment (temporary SQLite database, throwaway fixture
 * tree, stub yt-dlp/ffmpeg/ffprobe). No production archive, no real Plex or
 * source credentials are touched.
 *
 * Verifies: A archive scan, B identity creation, C checksum creation,
 * D exact duplicate detection, E quality comparison, F acquisition finding
 * creation, G integration capability discovery, H naming proposal generation,
 * I proposal approval, J dry-run mutation, K safe rename/move, L rollback,
 * M download temporary-directory fallback, N ownership isolation.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { archiveDb, readSettings, writeSettings } from "../src/lib/archive-db";
import { startArchiveScan, readArchiveScan, readArchiveInventory } from "../src/services/archive";
import { readQualityFindings, readRecordQualityReport } from "../src/services/archive-quality";
import {
  readNamingProposals,
  setNamingProposalDecisions,
} from "../src/services/naming-intelligence";
import {
  applyNamingProposals,
  readOperations,
  rollbackOperation,
} from "../src/services/archive-operations";
import {
  listAcquisitionFindings,
  refreshAcquisitionIntelligence,
  updateAcquisitionFindingReview,
  upsertAcquisitionCandidate,
} from "../src/services/acquisition-intelligence";
import { integrations } from "../src/integrations";
import { createJob } from "../src/services/download-engine";
import { inspectMediaSource, prepareDownload } from "../src/services/media";

const root = process.env.ARCHIVE_TEST_ROOT;
assert.ok(root, "ARCHIVE_TEST_ROOT must point at the temporary fixture root");
const ownerA = "smoke-owner-a";
const ownerB = "smoke-owner-b";

describe("integration smoke (temporary environment)", { concurrency: false }, () => {
  test("A–E: scan, identities, checksums, duplicates, quality", async () => {
    const moviesRoot = join(root, "movies");
    const tvRoot = join(root, "tv", "Tv Shows");
    const downloadsRoot = join(root, "downloads");
    const tmpRoot = join(root, "tmp");
    const binRoot = join(root, "bin");
    for (const dir of [moviesRoot, join(tvRoot, "Some Show S1", "Season 01"), downloadsRoot, tmpRoot, binRoot]) {
      await mkdir(dir, { recursive: true });
    }

    // Stub ffprobe: resolution/codec by filename, everything else generic.
    const ffprobePath = join(binRoot, "fake-ffprobe.mjs");
    await writeFile(ffprobePath, `#!/usr/bin/env node
const file = process.argv.at(-1) ?? "";
const is2160 = file.includes("2160");
process.stdout.write(JSON.stringify({
  format: { duration: "1234.5", bit_rate: is2160 ? "28000000" : "8000000", format_name: "matroska,webm" },
  streams: [
    { codec_type: "video", codec_name: is2160 ? "hevc" : "h264", width: is2160 ? 3840 : 1920, height: is2160 ? 2160 : 1080, r_frame_rate: "24000/1001", color_transfer: is2160 ? "smpte2084" : "bt709" },
    { codec_type: "audio", codec_name: "eac3", channels: 6, tags: { language: "eng" } },
  ],
}));`);
    await chmod(ffprobePath, 0o755);

    // Stub yt-dlp: deterministic --dump-single-json payload for any URL.
    const ytDlpPath = join(binRoot, "fake-yt-dlp.mjs");
    await writeFile(ytDlpPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  title: "The D'Amelio Show S01E01 stub signal",
  uploader: "Stub Channel",
  channel: "Stub Channel",
  description: "Stub yt-dlp inspection payload.",
  duration: 1337,
  upload_date: "20260901",
  webpage_url: "https://stub.invalid/watch",
  extractor_key: "stub",
  id: "stub-001",
  formats: [
    { format_id: "best-video", ext: "mp4", protocol: "https", width: 1920, height: 1080, vcodec: "avc1.640028", acodec: "mp4a.40.2", tbr: 4500, filesize: 750000000, dynamic_range: "sdr" },
    { format_id: "audio-only", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2", tbr: 128, filesize: 21000000 },
  ],
}));`);
    await chmod(ytDlpPath, 0o755);

    const ffmpegPath = join(binRoot, "fake-ffmpeg.mjs");
    await writeFile(ffmpegPath, `#!/usr/bin/env node
process.exit(0);`);
    await chmod(ffmpegPath, 0o755);

    // Fixtures: one messy TV episode (naming), a quality pair (encode review),
    // and one byte-identical pair (exact duplicate).
    await writeFile(join(tvRoot, "Some Show S1", "Season 01", "01 - Cold Open.mkv"), "pilot-master");
    await writeFile(join(moviesRoot, "Alpha.2024.1080p.mkv"), "alpha-1080");
    await writeFile(join(moviesRoot, "Alpha.2024.2160p.mkv"), "alpha-2160-higher-bitrate-payload");
    await writeFile(join(downloadsRoot, "Dup.One.mkv"), "same-bytes");
    await writeFile(join(downloadsRoot, "Dup.Two.mkv"), "same-bytes");

    writeSettings({
      archiveDirectory: [moviesRoot, tvRoot].join("\n"),
      downloadDirectory: downloadsRoot,
      temporaryDirectory: tmpRoot,
      ffprobePath,
      ffmpegPath,
      ytDlpPath,
      mockMode: false,
    });

    const waitForScan = async (ownerId: string) => {
      startArchiveScan(ownerId);
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const state = readArchiveScan(ownerId);
        if (state.status !== "scanning") return state;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("Archive scan did not finish.");
    };

    // A. Archive scan
    const scan = await waitForScan(ownerA);
    assert.equal(scan.status, "completed");
    assert.equal(scan.failedFiles, 0);

    const inventory = readArchiveInventory(ownerA);
    const recordOf = (filename: string) => inventory.records.find((r) => r.filename === filename);

    // B. Identity creation (sibling encodes and byte-identical copies share one identity)
    const identityRows = archiveDb
      .prepare("SELECT id, identity_key, media_type FROM local_media_identity WHERE owner_id = ?")
      .all(ownerA) as Array<{ id: number; identity_key: string; media_type: string }>;
    assert.ok(identityRows.length >= 3, "identities are created for the scanned files");
    assert.ok(identityRows.some((row) => row.media_type === "tv"), "the TV volume produces a tv identity");
    assert.ok(identityRows.some((row) => row.media_type === "movie" && row.identity_key.startsWith("movie:")));

    // C. Checksum creation (real SHA-256 of the bytes)
    const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
    assert.equal(recordOf("Dup.One.mkv")?.checksum, sha256("same-bytes"));
    assert.equal(recordOf("Alpha.2024.1080p.mkv")?.checksum, sha256("alpha-1080"));

    // D. Exact duplicate detection
    assert.equal(recordOf("Dup.One.mkv")?.qualityStatus, "duplicate");
    assert.equal(recordOf("Dup.Two.mkv")?.qualityStatus, "duplicate");

    // E. Quality comparison: the 2160p encode dominates the 1080p sibling.
    assert.equal(recordOf("Alpha.2024.2160p.mkv")?.qualityStatus, "best_local_version");
    assert.equal(recordOf("Alpha.2024.1080p.mkv")?.qualityStatus, "lower_quality_version");
    const lowerRecord = recordOf("Alpha.2024.1080p.mkv");
    assert.ok(lowerRecord);
    const report = readRecordQualityReport(ownerA, lowerRecord.id);
    assert.ok(report.findings.some((f) => f.kind === "lower_quality_duplicate" || f.kind === "probable_duplicate" || f.kind === "superior_encode_available"));
    const findings = readQualityFindings(ownerA, {});
    assert.ok(findings.results.length > 0, "quality findings exist for the messy archive");
  });

  test("F: acquisition finding creation for missing media", () => {
    // A missing movie surfaces as a recommended acquisition need.
    upsertAcquisitionCandidate(ownerA, {
      identityKey: "movie:the missing feature:2026",
      title: "The Missing Feature",
      mediaType: "movie",
      scope: "movie",
      year: 2026,
      provider: "stub-source",
      sourceKey: "stub-source:missing-feature",
      availabilityState: "available",
      estimatedSizeBytes: 4_000_000_000,
      confidence: 0.9,
      sourceConfidence: 0.85,
      checkedAt: "2026-09-10T00:00:00.000Z",
      quality: {
        height: 2160, hdr: true, videoCodec: "hevc", bitrate: 28_000_000,
        audioCodec: "eac3", audioChannels: 6, container: "mkv",
      },
    });
    const refreshed = refreshAcquisitionIntelligence(ownerA);
    assert.ok(refreshed.findingCount > 0);
    const findings = listAcquisitionFindings(ownerA, {});
    const missing = findings.results.find((f) => f.need.identity.key === "movie:the missing feature:2026");
    assert.ok(missing, "the missing movie produces a finding");
    assert.equal(missing.recommendation.status, "recommended");
    assert.equal(missing.need.archiveState, "missing");
    // Review decisions persist and are scoped.
    const reviewed = updateAcquisitionFindingReview(ownerA, missing.id, "reviewed", "Approved for later");
    assert.equal(reviewed?.review.status, "reviewed");
  });

  test("G: integration capability discovery stays provider-neutral", () => {
    // Plex implements media_host_inventory; with no credentials configured it
    // is described but exposes no available capabilities (no fake connections).
    const plex = integrations.describe(ownerA, "plex");
    assert.ok(plex, "plex is registered and described without credentials");
    assert.deepEqual(plex.capabilities, ["media_host_inventory"]);
    assert.equal(plex.state, "not_configured");
    assert.deepEqual(plex.availableCapabilities, [], "unconfigured providers expose nothing");
    assert.deepEqual(integrations.discover(ownerA, "media_host_inventory"), []);

    // The provider-neutral catalog lists placeholders for every planned adapter.
    const catalog = integrations.list(ownerA);
    const ids = catalog.map((d) => d.id).sort();
    for (const expected of ["mpilot", "plex", "prowlarr", "qbittorrent", "radarr", "sonarr", "telegram"]) {
      assert.ok(ids.includes(expected), `${expected} is in the catalog`);
    }
    assert.ok(catalog.every((d) => !JSON.stringify(d).includes("token")), "descriptors never leak credentials");
  });

  test("H–L: naming proposal → approval → dry-run → safe mutation → rollback", async () => {
    const naming = await readNamingProposals(ownerA);
    const proposal = naming.results.find((entry) => entry.sourceFilename === "01 - Cold Open.mkv");
    assert.ok(proposal, "H: the messy episode produces a naming proposal");
    assert.equal(proposal.confidence, "high");
    assert.ok(proposal.proposedPath, "the proposal has an executable destination");
    const proposedPath = proposal.proposedPath as string;

    // Apply is gated before approval.
    const gated = await applyNamingProposals(ownerA, [proposal.fileRecordId]);
    assert.equal(gated.results[0]?.success, false);

    // I. Proposal approval
    const decision = await setNamingProposalDecisions(ownerA, [
      { fileRecordId: proposal.fileRecordId, status: "accepted", note: "smoke approval" },
    ]);
    assert.equal(decision.results[0]?.success, true);

    // J. Dry-run mutation: full checks, zero writes.
    const before = await stat(proposal.sourcePath);
    const dry = await applyNamingProposals(ownerA, [proposal.fileRecordId], { dryRun: true });
    assert.equal(dry.results[0]?.success, true, `dry run: ${dry.results[0]?.error}`);
    assert.ok(dry.results[0]?.plan?.checks?.every((c) => c.ok));
    const afterDry = await stat(proposal.sourcePath);
    assert.equal(before.mtimeMs, afterDry.mtimeMs, "dry-run never touches the file");

    // K. Safe rename/move through the journaled engine.
    const applied = await applyNamingProposals(ownerA, [proposal.fileRecordId]);
    assert.equal(applied.results[0]?.success, true, `apply: ${applied.results[0]?.error}`);
    const operation = applied.results[0]?.operation;
    assert.ok(operation, "the mutation is journaled");
    assert.equal(operation.status, "succeeded");
    assert.ok(operation.rollbackAvailable);
    const moved = await stat(proposedPath);
    assert.ok(moved, "the file now lives at the proposed path");
    const rescanned = readArchiveInventory(ownerA).records.find((r) => r.path === proposedPath);
    assert.ok(rescanned, "the archive inventory follows the moved file after re-scan");

    // L. Rollback restores the original layout.
    const rolled = await rollbackOperation(ownerA, operation.id);
    assert.equal(rolled.status, "rolled_back");
    const restored = await stat(proposal.sourcePath);
    assert.ok(restored, "rollback restores the source path");
  });

  test("M: download preparation inherits the configured temporary directory", async () => {
    const settings = readSettings();
    const input = {
      sourceUrl: "https://stub.invalid/watch?v=smoke",
      title: "Smoke Feature 2026",
      selectedFormatId: "best",
    };
    const spec = prepareDownload(input, settings);
    assert.equal(spec.temporaryDirectory, resolve(join(root, "tmp")), "omitted temp dir falls back to settings");

    assert.throws(
      () => prepareDownload({ ...input, temporaryDirectory: "/etc" }, settings),
      /limited to configured Archive Assistant directories/,
    );

    // Job creation inherits the same fallback end to end.
    const job = createJob(input, ownerA, settings);
    assert.equal(job.temporaryDirectory, resolve(join(root, "tmp")));

    // The real yt-dlp inspection path runs against the stub binary.
    const inspection = await inspectMediaSource(input.sourceUrl, { ...settings, mockMode: false }, true);
    assert.ok(inspection.formats.length >= 2);
    assert.equal(inspection.metadata.title, "The D'Amelio Show S01E01 stub signal");
    assert.equal(inspection.metadata.extractor, "stub");
  });

  test("N: ownership isolation across every subsystem", async () => {
    assert.equal(readArchiveInventory(ownerB).records.length, 0, "B sees none of A's records");
    assert.equal((await readNamingProposals(ownerB)).results.length, 0, "B sees none of A's proposals");
    assert.equal(listAcquisitionFindings(ownerB, {}).results.length, 0, "B sees none of A's findings");
    assert.deepEqual(readOperations(ownerB), [], "B sees none of A's journal");

    const proposal = (await readNamingProposals(ownerA)).results.find(
      (entry) => entry.sourceFilename === "01 - Cold Open.mkv",
    );
    assert.ok(proposal);
    const crossDecision = await setNamingProposalDecisions(ownerB, [
      { fileRecordId: proposal.fileRecordId, status: "accepted" },
    ]);
    assert.equal(crossDecision.results[0]?.success, false, "B cannot decide on A's archive");
    const crossApply = await applyNamingProposals(ownerB, [proposal.fileRecordId]);
    assert.equal(crossApply.results[0]?.success, false, "B cannot mutate A's archive");
  });
});
