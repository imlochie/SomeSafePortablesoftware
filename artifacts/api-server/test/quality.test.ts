/**
 * Tests for the archive quality intelligence layer.
 *
 * Two kinds of fixtures are used deliberately:
 *
 * - Deterministic FFprobe-like JSON payloads for the normalized model, so the
 *   parsing rules are pinned without needing real media.
 * - Temporary `file_record` / `local_media_identity` rows for findings, so no
 *   media file is ever created, read, moved, or deleted by these tests.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { archiveDb, addEvent } from "../src/lib/archive-db";
import { invalidateArchiveInventoryCache } from "../src/services/archive";
import {
  compareEncodes,
  coarseQualityScore,
  parsePixelFormat,
  releaseMarkers,
  classifyProvenance,
  technicalQualityFromProbe,
  technicalQualityFromRecord,
  type ProbeQualitySource,
} from "../src/services/media-quality";
import {
  readQualityFindings,
  readRecordQualityReport,
  saveQualityFindingReview,
} from "../src/services/archive-quality";
import { GetArchiveQualityFindingsResponse } from "@workspace/api-zod";

const ownerA = "quality-owner-a";
const ownerB = "quality-owner-b";

/** Minimal FFprobe-shaped payload with string numeric fields, as ffprobe emits. */
function probeFixture(overrides: {
  duration?: string;
  bitRate?: string;
  formatName?: string;
  height?: number;
  width?: number;
  codec?: string;
  profile?: string;
  pixFmt?: string;
  colorTransfer?: string;
  sideData?: string[];
  audio?: Array<{ codec: string; channels: number; layout?: string; language?: string; bitRate?: string; profile?: string }>;
  subtitles?: Array<{ language?: string; codec?: string; forced?: boolean; default?: boolean }>;
} = {}): ProbeQualitySource {
  const streams: Array<Record<string, unknown>> = [];
  if (overrides.height !== undefined || overrides.codec) {
    streams.push({
      index: 0,
      codec_type: "video",
      codec_name: overrides.codec ?? "hevc",
      profile: overrides.profile ?? "Main 10",
      width: overrides.width ?? 3840,
      height: overrides.height ?? 2160,
      pix_fmt: overrides.pixFmt ?? "yuv420p10le",
      r_frame_rate: "24000/1001",
      color_transfer: overrides.colorTransfer ?? "smpte2084",
      color_primaries: "bt2020",
      ...(overrides.sideData ? { side_data_list: overrides.sideData.map((side_data_type) => ({ side_data_type })) } : {}),
    });
  }
  for (const [index, audio] of (overrides.audio ?? [{ codec: "eac3", channels: 6, layout: "5.1(side)", language: "eng" }]).entries()) {
    streams.push({
      index: index + 1,
      codec_type: "audio",
      codec_name: audio.codec,
      profile: audio.profile ?? "Dolby Digital Plus + Dolby Atmos",
      channels: audio.channels,
      channel_layout: audio.layout ?? "5.1(side)",
      bit_rate: audio.bitRate ?? "768000",
      tags: audio.language ? { language: audio.language } : {},
      disposition: index === 0 ? { default: 1 } : {},
    });
  }
  for (const [index, subtitle] of (overrides.subtitles ?? []).entries()) {
    streams.push({
      index: 100 + index,
      codec_type: "subtitle",
      codec_name: subtitle.codec ?? "subrip",
      tags: subtitle.language ? { language: subtitle.language } : {},
      disposition: { default: subtitle.default ? 1 : 0, forced: subtitle.forced ? 1 : 0 },
    });
  }
  return {
    format: {
      duration: overrides.duration ?? "7200.25",
      bit_rate: overrides.bitRate ?? "28000000",
      format_name: overrides.formatName ?? "matroska,webm",
    },
    streams,
  };
}

function qualityFromProbe(overrides: Parameters<typeof probeFixture>[0] = {}, meta: { label?: string; checksum?: string | null; sizeBytes?: number | null } = {}) {
  return technicalQualityFromProbe(probeFixture(overrides), {
    reference: `probe:${meta.label ?? "fixture"}`,
    label: meta.label ?? "fixture.mkv",
    filename: meta.label ?? "fixture.mkv",
    checksum: meta.checksum ?? null,
    sizeBytes: meta.sizeBytes ?? null,
    checksumStatus: meta.checksum ? "computed" : "not_computed",
  });
}

type FileRecordFixture = {
  id?: number;
  ownerId: string;
  filename: string;
  path: string;
  identityKey?: string | null;
  scanStatus?: "active" | "missing" | "error";
  sizeBytes?: number | null;
  checksum?: string | null;
  checksumStatus?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  durationSeconds?: number | null;
  videoCodec?: string | null;
  videoProfile?: string | null;
  videoPixFmt?: string | null;
  bitrate?: number | null;
  videoBitrate?: number | null;
  audioBitrate?: number | null;
  container?: string | null;
  dynamicRange?: string | null;
  audioCodec?: string | null;
  audioProfile?: string | null;
  audioChannels?: number | null;
  audioChannelLayout?: string | null;
  audioLanguages?: string[];
  subtitleLanguages?: string[];
  fingerprint?: string | null;
  volumeId?: string | null;
  archiveRoot?: string | null;
  errorMessage?: string | null;
};

let nextFileRecordId = 1000;
let nextIdentityId = 1000;

function insertFileRecord(fixture: FileRecordFixture) {
  let localIdentityId: number | null = null;
  if (fixture.identityKey) {
    // One identity row per (owner, identity key); several file records may point
    // at it, exactly like the scanner does.
    archiveDb.prepare(`
      INSERT OR IGNORE INTO local_media_identity
        (id, owner_id, identity_key, media_type, normalized_title, year, size_bytes, fingerprint, checksum)
      VALUES (?, ?, ?, 'movie', ?, NULL, ?, ?, ?)
    `).run(
      nextIdentityId++,
      fixture.ownerId,
      fixture.identityKey,
      fixture.identityKey.split(":")[1] ?? "",
      fixture.sizeBytes ?? null,
      fixture.fingerprint ?? null,
      fixture.checksum ?? null,
    );
    localIdentityId = Number(
      (archiveDb.prepare(
        "SELECT id FROM local_media_identity WHERE owner_id = ? AND identity_key = ?",
      ).get(fixture.ownerId, fixture.identityKey) as { id: number }).id,
    );
  }
  const id = fixture.id ?? nextFileRecordId++;
  archiveDb.prepare(`
    INSERT INTO file_record
      (id, path, owner_id, archive_item_id, filename, relative_path, size_bytes, checksum, checksum_status,
       media_type, scan_status, duration_seconds, video_codec, audio_codec, width, height, fps, bitrate,
       container, dynamic_range, audio_channels, audio_languages, subtitle_languages, fingerprint,
       video_profile, video_pix_fmt, audio_profile, audio_channel_layout, video_bitrate, audio_bitrate,
       audio_tracks, subtitle_tracks, error_message, volume_id, archive_root, modified_at_ms)
    VALUES
      (?, ?, ?, NULL, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, 1700000000000)
  `).run(
    id,
    fixture.path,
    fixture.ownerId,
    fixture.filename,
    fixture.filename,
    fixture.sizeBytes ?? null,
    fixture.checksum ?? null,
    fixture.checksumStatus ?? (fixture.checksum ? "computed" : "not_computed"),
    "movie",
    fixture.scanStatus ?? "active",
    fixture.durationSeconds ?? null,
    fixture.videoCodec ?? null,
    fixture.audioCodec ?? null,
    fixture.width ?? null,
    fixture.height ?? null,
    fixture.fps ?? null,
    fixture.bitrate ?? null,
    fixture.container ?? "matroska,webm",
    fixture.dynamicRange ?? null,
    fixture.audioChannels ?? null,
    JSON.stringify(fixture.audioLanguages ?? []),
    JSON.stringify(fixture.subtitleLanguages ?? []),
    fixture.fingerprint ?? null,
    fixture.videoProfile ?? null,
    fixture.videoPixFmt ?? null,
    fixture.audioProfile ?? null,
    fixture.audioChannelLayout ?? null,
    fixture.videoBitrate ?? null,
    fixture.audioBitrate ?? null,
    "[]",
    "[]",
    fixture.errorMessage ?? null,
    fixture.volumeId ?? "d-movies",
    fixture.archiveRoot ?? "D:\\Movies",
  );
  if (localIdentityId !== null) {
    archiveDb.prepare("UPDATE file_record SET local_identity_id = ? WHERE id = ?").run(localIdentityId, id);
  }
  return id;
}

function freshOwnerScope() {
  invalidateArchiveInventoryCache(ownerA);
  invalidateArchiveInventoryCache(ownerB);
}

describe("normalized technical quality model", () => {
  test("parses FFprobe string numerics, dynamic range, bit depth, and tracks", () => {
    const quality = qualityFromProbe({
      duration: "5412.75",
      bitRate: "19800000",
      height: 2160,
      width: 3840,
      codec: "hevc",
      profile: "Main 10",
      pixFmt: "yuv420p10le",
      colorTransfer: "smpte2084",
      sideData: ["HDR10+ Static Metadata"],
      audio: [
        { codec: "truehd", channels: 8, layout: "7.1 (wave-based)", language: "eng", bitRate: "3988000", profile: undefined },
        { codec: "ac3", channels: 2, layout: "mono? no", language: "spa", bitRate: "224000" },
      ],
      subtitles: [{ language: "spa" }, { language: "eng", forced: true }],
    }, { label: "Movie.2025.mkv", sizeBytes: 9_000_000_000, checksum: "a".repeat(64) });

    // FFprobe reports duration/bit_rate as strings; they must survive parsing.
    assert.equal(quality.durationSeconds, 5412.75);
    assert.equal(quality.containerBitrate, 19_800_000);
    assert.equal(quality.audioBitrate, 3_988_000);
    assert.equal(quality.videoBitrate, null);

    assert.equal(quality.width, 3840);
    assert.equal(quality.height, 2160);
    assert.equal(quality.pixels, 3840 * 2160);
    assert.equal(quality.resolution, "2160p");
    assert.equal(quality.bitDepth, 10);
    assert.equal(quality.chromaSubsampling, "420");
    assert.equal(quality.videoCodecClass, 3);
    assert.equal(quality.dynamicRange, "hdr10_plus");
    assert.equal(quality.framerate, 23.976);
    assert.equal(quality.container, "matroska,webm");
    assert.equal(quality.checksumStatus, "computed");
    assert.equal(quality.technicalMetadataMissing, false);

    // Every audio track is kept: codec, layout, language, and bitrate.
    assert.equal(quality.audioTracks.length, 2);
    assert.deepEqual(quality.audioTracks.map((track) => track.language), ["eng", "spa"]);
    assert.deepEqual(quality.audioLanguages, ["eng", "spa"]);
    assert.deepEqual(quality.subtitleLanguages, ["eng", "spa"]);
    assert.equal(quality.audioChannels, 8);
    assert.ok(quality.bitsPerPixelFrame !== null && quality.bitsPerPixelFrame > 0);

    // Release provenance is derived from the filename, not guessed.
    assert.equal(classifyProvenance("Movie.2025.2160p.UHD.BluRay.x265-GRP.mkv"), "disc_encode");
    assert.deepEqual(releaseMarkers("Movie.2025.2160p.UHD.BluRay.x265-GRP.mkv"), ["uhd", "bluray", "x265"]);
    assert.equal(classifyProvenance("Movie.2025.1080p.WEB-DL-AAC.mkv"), "web_dl");
    assert.equal(classifyProvenance("Movie.2025.mkv"), "unknown");
  });

  test("classifies pixel formats and treats absent metadata as unknown, never as worse", () => {
    assert.deepEqual(parsePixelFormat("yuv420p"), { bitDepth: 8, chroma: "420" });
    assert.deepEqual(parsePixelFormat("yuv420p10le"), { bitDepth: 10, chroma: "420" });
    assert.deepEqual(parsePixelFormat("gray"), { bitDepth: 8, chroma: "400" });
    assert.deepEqual(parsePixelFormat("yuv444p"), { bitDepth: 8, chroma: "444" });
    assert.deepEqual(parsePixelFormat(null), { bitDepth: null, chroma: null });

    const sdr = qualityFromProbe({ colorTransfer: "bt709", sideData: undefined, height: 1080, width: 1920, codec: "h264" });
    assert.equal(sdr.dynamicRange, "sdr");
    const bare = technicalQualityFromRecord({
      id: 1,
      filename: "no-metadata.mkv",
    });
    assert.equal(bare.dynamicRange, "unknown");
    assert.equal(bare.technicalMetadataMissing, true);
    assert.equal(bare.checksumStatus, "not_computed");
  });

  test("rebuilds an identical model from the stored file_record columns", () => {
    const probed = qualityFromProbe({
      duration: "3600",
      bitRate: "8000000",
      height: 1080,
      width: 1920,
      codec: "h264",
      profile: "High",
      pixFmt: "yuv420p",
      colorTransfer: "bt709",
    }, { label: "Stored.2024.mkv", sizeBytes: 500, checksum: "b".repeat(64) });
    const stored = technicalQualityFromRecord({
      id: 42,
      filename: "Stored.2024.mkv",
      duration_seconds: 3600,
      bitrate: 8_000_000,
      width: 1920,
      height: 1080,
      video_codec: "h264",
      video_profile: "High",
      video_pix_fmt: "yuv420p",
      dynamic_range: "bt709",
      audio_codec: "eac3",
      audio_channels: 6,
      audio_languages: "[\"eng\"]",
      subtitle_languages: "[]",
      container: "matroska,webm",
      size_bytes: 500,
      checksum: "b".repeat(64),
      checksum_status: "computed",
      fps: 23.976,
    });
    assert.equal(stored.dynamicRange, probed.dynamicRange);
    assert.equal(stored.bitDepth, probed.bitDepth);
    assert.equal(stored.videoCodecClass, probed.videoCodecClass);
    assert.equal(stored.containerBitrate, probed.containerBitrate);
    assert.equal(stored.height, probed.height);
    assert.equal(coarseQualityScore(stored), coarseQualityScore(probed));
  });
});

describe("quality comparison engine", () => {
  test("identical checksums are an exact duplicate regardless of other metadata", () => {
    const checksum = "c".repeat(64);
    const left = qualityFromProbe({}, { label: "A.mkv", checksum, sizeBytes: 1000 });
    const right = qualityFromProbe({}, { label: "B.mkv", checksum, sizeBytes: 1000 });
    const comparison = compareEncodes(left, right);
    assert.equal(comparison.relationship, "exact_duplicate");
    assert.equal(comparison.winner, null);
    assert.equal(comparison.confidence, "high");
    assert.ok(comparison.identical);
    assert.ok(comparison.reasons.some((reason) => /SHA-256/.test(reason)));
  });

  test("dominance requires being at least as good everywhere and better somewhere", () => {
    const better = qualityFromProbe({
      height: 2160,
      width: 3840,
      codec: "hevc",
      bitRate: "30000000",
      colorTransfer: "smpte2084",
    }, { label: "better.mkv", checksum: "d".repeat(64), sizeBytes: 4_000_000_000 });
    const worse = qualityFromProbe({
      height: 1080,
      width: 1920,
      codec: "hevc",
      bitRate: "12000000",
      colorTransfer: "bt709",
    }, { label: "worse.mkv", checksum: "e".repeat(64), sizeBytes: 2_000_000_000 });

    const superior = compareEncodes(better, worse);
    assert.equal(superior.relationship, "superior_encode");
    assert.equal(superior.winner, "left");
    assert.equal(superior.confidence, "high");
    assert.ok(superior.reasons.some((reason) => /dominance rather than a tradeoff/.test(reason)));

    const inferior = compareEncodes(worse, better);
    assert.equal(inferior.relationship, "inferior_encode");
    assert.equal(inferior.winner, "right");
  });

  test("higher resolution with lower bitrate is a tradeoff, not a win", () => {
    const big = qualityFromProbe({
      height: 2160,
      width: 3840,
      codec: "h264",
      bitRate: "6000000",
      colorTransfer: "bt709",
    }, { label: "4k-starved.mkv", checksum: "1".repeat(64), sizeBytes: 3_000_000_000 });
    const small = qualityFromProbe({
      height: 1080,
      width: 1920,
      codec: "h264",
      bitRate: "12000000",
      colorTransfer: "bt709",
    }, { label: "1080p-rich.mkv", checksum: "2".repeat(64), sizeBytes: 3_000_000_000 });

    const comparison = compareEncodes(big, small);
    assert.equal(comparison.relationship, "materially_different_encode");
    assert.equal(comparison.winner, null);
    assert.ok(comparison.uncertainty.length > 0);
    const resolutionAxis = comparison.axes.find((axis) => axis.axis === "resolution");
    const bitrateAxis = comparison.axes.find((axis) => axis.axis === "bitrate");
    assert.equal(resolutionAxis?.status, "left_better");
    assert.equal(bitrateAxis?.status, "right_better");
    assert.equal(resolutionAxis?.materiality, "ranked");
    assert.equal(bitrateAxis?.materiality, "ranked");
  });

  test("bitrate is never ranked across different codec generations", () => {
    const modern = qualityFromProbe({ codec: "hevc", bitRate: "9000000", height: 1080, width: 1920, colorTransfer: "bt709" }, { label: "hevc.mkv", checksum: "3".repeat(64) });
    const legacy = qualityFromProbe({ codec: "h264", bitRate: "20000000", height: 1080, width: 1920, colorTransfer: "bt709" }, { label: "h264.mkv", checksum: "4".repeat(64) });
    const comparison = compareEncodes(modern, legacy);
    const bitrateAxis = comparison.axes.find((axis) => axis.axis === "bitrate");
    assert.equal(bitrateAxis?.materiality, "escalating");
    assert.ok(bitrateAxis?.note && /not comparable across codec generations/.test(bitrateAxis.note));
    assert.ok(comparison.uncertainty.some((note) => /more efficient codec/.test(note)));
    // The codec generation gap is itself a ranked axis, so the more efficient
    // encode wins on measured axes even while the raw bitrate stays unranked.
    assert.equal(comparison.relationship, "superior_encode");
    assert.equal(comparison.winner, "left");
  });

  test("framerate and container are differences without an ordering", () => {
    const movie = qualityFromProbe({ codec: "hevc", bitRate: "20000000" }, { label: "24fps.mkv", checksum: "5".repeat(64) });
    // Same encode, different frame rate: reported, never ranked.
    const smooth = technicalQualityFromRecord({
      id: 77,
      filename: "60fps.mkv",
      height: 2160,
      width: 3840,
      video_codec: "hevc",
      bitrate: 20_000_000,
      duration_seconds: 7200.25,
      container: "matroska,webm",
      fps: 59.94,
      checksum: "6".repeat(64),
      checksum_status: "computed",
    });
    const comparison = compareEncodes(movie, smooth);
    const framerateAxis = comparison.axes.find((axis) => axis.axis === "framerate");
    assert.equal(framerateAxis?.materiality, "escalating");
    assert.ok(framerateAxis?.status === "right_better" || framerateAxis?.status === "different");
    assert.ok(framerateAxis?.note && /not automatically better/.test(framerateAxis.note));
    assert.equal(comparison.winner, null);
    assert.equal(comparison.relationship, "materially_different_encode");

    // Container is informational: it is reported, but never picks a side.
    const otherContainer = technicalQualityFromRecord({
      id: 78,
      filename: "same-encode.mp4",
      height: 2160,
      width: 3840,
      video_codec: "hevc",
      bitrate: 20_000_000,
      duration_seconds: 7200.25,
      container: "mp4",
      fps: movie.framerate,
      checksum: "7".repeat(64),
      checksum_status: "computed",
    });
    const containerComparison = compareEncodes(movie, otherContainer);
    const containerAxis = containerComparison.axes.find((axis) => axis.axis === "container");
    assert.equal(containerAxis?.materiality, "informational");
    assert.equal(containerComparison.winner, null);
  });

  test("an unknown axis is uncertainty, never a manufactured difference", () => {
    const complete = technicalQualityFromRecord({
      id: 80,
      filename: "complete.mkv",
      height: 1080,
      width: 1920,
      video_codec: "h264",
      bitrate: 8_000_000,
      duration_seconds: 3600,
      audio_codec: "aac",
      audio_channels: 6,
      fps: 23.976,
      container: "matroska,webm",
      size_bytes: 3_600_000_000,
    });
    // Same measurable facts, but framerate, layout, and languages are missing.
    const sparse = technicalQualityFromRecord({
      id: 81,
      filename: "sparse.mkv",
      height: 1080,
      width: 1920,
      video_codec: "h264",
      bitrate: 8_000_000,
      duration_seconds: 3600,
      audio_codec: "aac",
      audio_channels: 6,
      container: "matroska,webm",
      size_bytes: 3_600_000_000,
    });
    const comparison = compareEncodes(complete, sparse);
    const unknownAxes = comparison.axes.filter((axis) => axis.status === "unknown");
    assert.ok(unknownAxes.length > 0);
    // Missing data alone must not be reported as a difference between files.
    assert.ok(unknownAxes.every((axis) => axis.status !== "different"));
    assert.notEqual(comparison.relationship, "materially_different_encode");
    assert.equal(comparison.winner, null);
    // Without any checksum the strongest claim available is "probable".
    assert.equal(comparison.relationship, "probable_duplicate");
  });

  test("HDR versus resolution is left to the operator", () => {
    const hdr1080 = qualityFromProbe({ height: 1080, width: 1920, codec: "hevc", bitRate: "12000000", colorTransfer: "smpte2084" }, { label: "hdr-1080.mkv", checksum: "8".repeat(64) });
    const sdr4k = qualityFromProbe({ height: 2160, width: 3840, codec: "hevc", bitRate: "12000000", colorTransfer: "bt709" }, { label: "sdr-2160.mkv", checksum: "9".repeat(64) });
    const comparison = compareEncodes(hdr1080, sdr4k);
    assert.equal(comparison.relationship, "materially_different_encode");
    assert.equal(comparison.winner, null);
    const dynamicRangeAxis = comparison.axes.find((axis) => axis.axis === "dynamic_range");
    assert.equal(dynamicRangeAxis?.status, "left_better");
  });

  test("runtime differences stop the comparison instead of inventing a verdict", () => {
    const theatrical = qualityFromProbe({ duration: "5400" }, { label: "theatrical.mkv", checksum: "a".repeat(63) + "0" });
    const extended = qualityFromProbe({ duration: "7200" }, { label: "extended.mkv", checksum: "a".repeat(63) + "1" });
    const comparison = compareEncodes(theatrical, extended);
    assert.equal(comparison.relationship, "different_media");
    assert.equal(comparison.winner, null);
    assert.equal(comparison.confidence, null);
    assert.ok(comparison.reasons.some((reason) => /No quality verdict/.test(reason)));
  });

  test("missing metadata yields uncertainty rather than a ranking", () => {
    const empty = technicalQualityFromRecord({ id: 90, filename: "unknown.mkv" });
    const partial = technicalQualityFromRecord({ id: 91, filename: "partial.mkv", size_bytes: 1234 });
    const comparison = compareEncodes(empty, partial);
    assert.equal(comparison.relationship, "insufficient_metadata");
    assert.equal(comparison.winner, null);
    assert.equal(comparison.confidence, null);
    assert.ok(comparison.uncertainty.some((note) => /No shared ranked axis/.test(note)));
  });
});

describe("archive quality findings", () => {
  test("exact duplicates, probable duplicates, and encode relationships are reported", () => {
    const identical = "f".repeat(64);
    const other = "e".repeat(64);
    const dupA = insertFileRecord({
      ownerId: ownerA,
      filename: "Duplicate.Alpha.mkv",
      path: "D:\\Movies\\Duplicate.Alpha.mkv",
      identityKey: "movie:duplicate alpha:",
      checksum: identical,
      // Coherent average bitrate for the declared duration (25 Mbps x 5400 s).
      sizeBytes: 16_875_000_000,
      height: 2160,
      width: 3840,
      durationSeconds: 5400,
      videoCodec: "hevc",
      audioCodec: "eac3",
      audioChannels: 6,
      bitrate: 25_000_000,
      dynamicRange: "smpte2084",
      fingerprint: "duplicate alpha|5400|3840|2160|hevc|eac3",
    });
    const dupB = insertFileRecord({
      ownerId: ownerA,
      filename: "Duplicate.Beta.mkv",
      path: "D:\\Movies\\Duplicate.Beta.mkv",
      identityKey: "movie:duplicate beta:",
      checksum: identical,
      sizeBytes: 16_875_000_000,
      height: 2160,
      width: 3840,
      durationSeconds: 5400,
      videoCodec: "hevc",
      audioCodec: "eac3",
      audioChannels: 6,
      bitrate: 25_000_000,
      dynamicRange: "smpte2084",
      fingerprint: "duplicate beta|5400|3840|2160|hevc|eac3",
    });
    const probableId = insertFileRecord({
      ownerId: ownerA,
      filename: "Duplicate.Gamma.mkv",
      path: "D:\\Movies\\Duplicate.Gamma.mkv",
      identityKey: "movie:duplicate gamma:",
      checksum: other,
      sizeBytes: 16_875_000_000,
      height: 2160,
      width: 3840,
      durationSeconds: 5400,
      videoCodec: "hevc",
      audioCodec: "eac3",
      audioChannels: 6,
      bitrate: 25_000_000,
      dynamicRange: "smpte2084",
      fingerprint: "duplicate alpha|5400|3840|2160|hevc|eac3",
    });
    // A dominated version inside one identity, plus its better sibling.
    const inferiorId = insertFileRecord({
      ownerId: ownerA,
      filename: "Tradeoff.2025.1080p.mkv",
      path: "D:\\Movies\\Tradeoff.2025.1080p.mkv",
      identityKey: "movie:tradeoff:2025",
      checksum: "a1".padEnd(64, "0"),
      sizeBytes: 5_400_000_000,
      height: 1080,
      width: 1920,
      durationSeconds: 5400,
      videoCodec: "hevc",
      audioCodec: "aac",
      audioChannels: 2,
      bitrate: 8_000_000,
      dynamicRange: "bt709",
      fingerprint: "tradeoff|5400|1920|1080|hevc|aac",
    });
    const championId = insertFileRecord({
      ownerId: ownerA,
      filename: "Tradeoff.2025.2160p.mkv",
      path: "D:\\Movies\\Tradeoff.2025.2160p.mkv",
      identityKey: "movie:tradeoff:2025",
      checksum: "b2".padEnd(64, "0"),
      sizeBytes: 17_550_000_000,
      height: 2160,
      width: 3840,
      durationSeconds: 5400,
      videoCodec: "hevc",
      audioCodec: "eac3",
      audioChannels: 6,
      bitrate: 26_000_000,
      dynamicRange: "smpte2084",
      fingerprint: "tradeoff|5400|3840|2160|hevc|eac3",
    });
    insertFileRecord({
      ownerId: ownerA,
      filename: "Broken.mp4",
      path: "D:\\Movies\\Broken.mp4",
      identityKey: "movie:broken:",
      scanStatus: "error",
      sizeBytes: 12,
      container: null,
      fingerprint: null,
      errorMessage: "invalid data found when processing input",
    });
    freshOwnerScope();

    const response = readQualityFindings(ownerA);
    const byKind = (kind: string) => response.results.filter((finding) => finding.kind === kind);

    const exact = byKind("exact_duplicate");
    assert.deepEqual(
      exact.map((finding) => finding.fileRecordId).sort((left, right) => left - right),
      [dupA, dupB].sort((left, right) => left - right),
    );
    assert.ok(exact.every((finding) => finding.confidence === "high" && finding.severity === "high"));
    assert.ok(exact.every((finding) => finding.action === "review_only"));
    // The anchor record is the lowest id in the duplicate set, deterministically.
    assert.equal(exact.find((finding) => finding.fileRecordId === dupA)?.counterpartFileRecordId, dupB);
    assert.match(exact.find((finding) => finding.fileRecordId === dupA)?.reason ?? "", /shared with 1 other active record/);
    assert.ok(exact.every((finding) => finding.uncertainty.some((note) => /different media identities/.test(note))));

    const probableResults = byKind("probable_duplicate");
    assert.deepEqual(probableResults.map((finding) => finding.fileRecordId), [probableId]);
    assert.equal(probableResults[0]?.confidence, "medium");
    assert.ok(probableResults[0]?.reasons.some((reason) => /not identical/.test(reason)));

    assert.deepEqual(byKind("lower_quality_duplicate").map((finding) => finding.fileRecordId), [inferiorId]);
    const superior = byKind("superior_encode");
    assert.deepEqual(superior.map((finding) => finding.fileRecordId), [championId]);
    assert.equal(superior[0]?.winner, "left");
    assert.equal(superior[0]?.relationship, "superior_encode");
    assert.ok(superior[0]?.currentQuality.resolution === "2160p");
    assert.ok(byKind("missing_technical_metadata").length === 1);

    // Every finding describes the current quality of its own record.
    const lowerQuality = byKind("lower_quality_duplicate")[0];
    assert.ok(lowerQuality);
    assert.equal(lowerQuality.currentQuality.resolution, "1080p");
    assert.equal(lowerQuality.counterpart?.resolution, "2160p");
    assert.ok(lowerQuality.axes.some((axis) => axis.axis === "resolution" && axis.status === "right_better"));
    assert.ok(lowerQuality.reasons.some((reason) => /dominance rather than a tradeoff/.test(reason)));

    // The response shape is the published contract.
    const parsed = GetArchiveQualityFindingsResponse.parse(response);
    assert.equal(parsed.results.length, response.results.length);
    assert.ok(parsed.results[0]?.evidenceKey.length === 64);
    assert.equal(parsed.summary.total, response.summary.total);
  });

  test("conflicting technical metadata is reported when byte-identical records disagree", () => {
    const shared = "9".repeat(64);
    insertFileRecord({
      ownerId: ownerA,
      filename: "Conflict.One.mkv",
      path: "D:\\Movies\\Conflict.One.mkv",
      identityKey: "movie:conflict one:",
      checksum: shared,
      sizeBytes: 2_000_000_000,
      bitrate: null,
      height: 2160,
      width: 3840,
      durationSeconds: 5400,
      videoCodec: "hevc",
      audioCodec: "eac3",
      fingerprint: "conflict one|5400|3840|2160|hevc|eac3",
    });
    insertFileRecord({
      ownerId: ownerA,
      filename: "Conflict.Two.mkv",
      path: "D:\\Movies\\Conflict.Two.mkv",
      identityKey: "movie:conflict two:",
      checksum: shared,
      sizeBytes: 2_000_000_000,
      bitrate: null,
      // Impossible for byte-identical media: stale probe metadata.
      height: 1080,
      width: 1920,
      durationSeconds: 5400,
      videoCodec: "h264",
      audioCodec: "eac3",
      fingerprint: "conflict two|5400|1920|1080|h264|eac3",
    });
    freshOwnerScope();

    const response = readQualityFindings(ownerA, { kind: "conflicting_quality_metadata" });
    assert.equal(response.results.length, 2);
    assert.ok(response.results.every((finding) => finding.severity === "high"));
    assert.ok(response.results[0]?.reasons[0] && /byte-identical files report different technical metadata|the bytes are the same/i.test(`${response.results[0]?.headline} ${response.results[0]?.reasons[0]}`));
    // Being byte-identical still wins as an evidence class.
    assert.ok(response.results.every((finding) => finding.relationship === "exact_duplicate"));
  });

  test("findings never mutate archive state", () => {
    const before = archiveDb.prepare(
      "SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM file_record WHERE owner_id = ?",
    ).get(ownerA) as { files: number; bytes: number };
    const identityBefore = (archiveDb.prepare("SELECT COUNT(*) AS count FROM local_media_identity WHERE owner_id = ?").get(ownerA) as { count: number }).count;
    readQualityFindings(ownerA);
    readQualityFindings(ownerA, { includeReviewed: false });
    const response = readQualityFindings(ownerA, { reviewStatus: "unreviewed", pageSize: 2, page: 1 });
    for (const finding of response.results) readRecordQualityReport(ownerA, finding.fileRecordId);
    const after = archiveDb.prepare(
      "SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes FROM file_record WHERE owner_id = ?",
    ).get(ownerA) as { files: number; bytes: number };
    assert.equal(after.files, before.files);
    assert.equal(after.bytes, before.bytes);
    assert.equal(
      (archiveDb.prepare("SELECT COUNT(*) AS count FROM local_media_identity WHERE owner_id = ?").get(ownerA) as { count: number }).count,
      identityBefore,
    );
    assert.ok(response.pagination.pageSize === 2);
  });

  test("review decisions follow evidence: unchanged evidence stays reviewed, changed evidence reopens", () => {
    const first = insertFileRecord({
      ownerId: ownerA,
      filename: "Review.Pair.A.mkv",
      path: "D:\\Movies\\Review.Pair.A.mkv",
      identityKey: "movie:review pair:2024",
      checksum: "11".padEnd(64, "a"),
      sizeBytes: 3_000_000_000,
      height: 1080,
      width: 1920,
      durationSeconds: 4000,
      videoCodec: "h264",
      audioCodec: "aac",
      audioChannels: 2,
      bitrate: 6_000_000,
      dynamicRange: "bt709",
      fingerprint: "review pair|4000|1920|1080|h264|aac",
    });
    const second = insertFileRecord({
      ownerId: ownerA,
      filename: "Review.Pair.B.mkv",
      path: "D:\\Movies\\Review.Pair.B.mkv",
      identityKey: "movie:review pair:2024",
      checksum: "22".padEnd(64, "b"),
      sizeBytes: 10_000_000_000,
      height: 2160,
      width: 3840,
      durationSeconds: 4000,
      videoCodec: "h264",
      audioCodec: "eac3",
      audioChannels: 6,
      bitrate: 20_000_000,
      dynamicRange: "bt709",
      fingerprint: "review pair|4000|3840|2160|h264|eac3",
    });
    freshOwnerScope();

    const initial = readQualityFindings(ownerA, { fileRecordId: first });
    const finding = initial.results.find((candidate) => candidate.kind === "lower_quality_duplicate");
    assert.ok(finding, "expected a lower-quality duplicate finding for the weaker encode");
    assert.equal(finding.reviewStatus, "unreviewed");

    const saved = saveQualityFindingReview(ownerA, {
      fileRecordId: finding.fileRecordId,
      kind: finding.kind,
      evidenceKey: finding.evidenceKey,
      status: "reviewed",
      note: "Keeping both; the smaller file is the portable copy.",
    });
    assert.equal(saved?.status, "reviewed");
    assert.equal(saved?.findingType, "lower_quality_duplicate");
    assert.equal(saved?.note, "Keeping both; the smaller file is the portable copy.");

    // The dominant side of the same pair is reported as a superior encode.
    assert.deepEqual(
      readQualityFindings(ownerA, { fileRecordId: second, kind: "superior_encode" }).results.map(
        (candidate) => candidate.counterpartFileRecordId,
      ),
      [first],
    );

    // Same evidence: the decision survives, and the evidence key is stable.
    const afterReview = readQualityFindings(ownerA, { fileRecordId: first });
    const stillReviewed = afterReview.results.find((candidate) => candidate.kind === "lower_quality_duplicate");
    assert.equal(stillReviewed?.reviewStatus, "reviewed");
    assert.equal(stillReviewed?.evidenceKey, finding.evidenceKey);

    // A meaningless change (last_seen_at) must not reopen the finding.
    archiveDb.prepare("UPDATE file_record SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(first);
    freshOwnerScope();
    assert.equal(
      readQualityFindings(ownerA, { fileRecordId: first }).results.find((candidate) => candidate.kind === "lower_quality_duplicate")?.reviewStatus,
      "reviewed",
    );

    // Meaningful evidence change: the weaker encode is re-probed and carries a
    // higher bitrate, so the comparison shifts and the finding reopens.
    archiveDb.prepare(
      "UPDATE file_record SET bitrate = 7000000, size_bytes = 3500000000 WHERE id = ?",
    ).run(first);
    freshOwnerScope();
    const reopened = readQualityFindings(ownerA, { fileRecordId: first }).results.find(
      (candidate) => candidate.kind === "lower_quality_duplicate",
    );
    assert.ok(reopened, "the finding should stay open with new evidence, not disappear");
    assert.notEqual(reopened.evidenceKey, finding.evidenceKey);
    assert.equal(reopened.reviewStatus, "unreviewed");
    // The prior decision is kept as history rather than deleted.
    const reviewRows = archiveDb.prepare(
      "SELECT COUNT(*) AS count FROM archive_review WHERE owner_id = ? AND file_record_id = ?",
    ).get(ownerA, first) as { count: number };
    assert.equal(reviewRows.count, 1);

    // Bulk-style filters see the reopened state.
    const unreviewed = readQualityFindings(ownerA, { reviewStatus: "unreviewed" });
    assert.ok(unreviewed.results.length > 0);
    const withoutReviewed = readQualityFindings(ownerA, { includeReviewed: false });
    assert.ok(withoutReviewed.results.every((candidate) => candidate.reviewStatus !== "reviewed"));
  });

  test("findings and reviews are owner-scoped", () => {
    const shared = "7".repeat(64);
    const id = insertFileRecord({
      ownerId: ownerA,
      filename: "Isolation.A.mkv",
      path: "D:\\Movies\\Isolation.A.mkv",
      identityKey: "movie:isolation:",
      checksum: shared,
      sizeBytes: 900,
      height: 1080,
      width: 1920,
      videoCodec: "h264",
      durationSeconds: 100,
    });
    insertFileRecord({
      ownerId: ownerA,
      filename: "Isolation.B.mkv",
      path: "D:\\Movies\\Isolation.B.mkv",
      identityKey: "movie:isolation:",
      checksum: shared,
      sizeBytes: 900,
      height: 1080,
      width: 1920,
      videoCodec: "h264",
      durationSeconds: 100,
    });
    freshOwnerScope();

    const ownerResults = readQualityFindings(ownerA, { fileRecordId: id });
    assert.ok(ownerResults.summary.total > 0);
    assert.equal(readQualityFindings(ownerB).summary.total, 0);
    assert.equal(readRecordQualityReport(ownerB, id), null);

    const finding = ownerResults.results[0];
    assert.ok(finding);
    assert.equal(
      saveQualityFindingReview(ownerB, {
        fileRecordId: finding.fileRecordId,
        kind: finding.kind,
        evidenceKey: finding.evidenceKey,
        status: "reviewed",
        note: null,
      }),
      null,
    );
    // A stale evidence key (evidence changed since the client last read it) is
    // rejected instead of silently attaching a review to the wrong finding.
    assert.equal(
      saveQualityFindingReview(ownerA, {
        fileRecordId: finding.fileRecordId,
        kind: finding.kind,
        evidenceKey: "stale-evidence-key",
        status: "reviewed",
        note: null,
      }),
      null,
    );
  });

  test("byte-identical copies never make an identity group ambiguous", () => {
    const copyChecksum = "5c".padEnd(64, "e");
    const twinA = insertFileRecord({
      ownerId: ownerA,
      filename: "Ambiguous.2025.1080p.mkv",
      path: "D:\\Movies\\Ambiguous.2025.1080p.mkv",
      identityKey: "movie:ambiguous:2025",
      checksum: copyChecksum,
      sizeBytes: 2_700_000_000,
      height: 1080,
      width: 1920,
      durationSeconds: 3600,
      videoCodec: "h264",
      audioCodec: "aac",
      audioChannels: 2,
      bitrate: 6_000_000,
      dynamicRange: "bt709",
      fingerprint: "ambiguous|3600|1920|1080|h264|aac",
    });
    const twinB: number = insertFileRecord({
      ownerId: ownerA,
      filename: "Ambiguous.2025.1080p.Copy.mkv",
      path: "D:\\Movies\\Ambiguous.2025.1080p.Copy.mkv",
      identityKey: "movie:ambiguous:2025",
      checksum: copyChecksum,
      sizeBytes: 2_700_000_000,
      height: 1080,
      width: 1920,
      durationSeconds: 3600,
      videoCodec: "h264",
      audioCodec: "aac",
      audioChannels: 2,
      bitrate: 6_000_000,
      dynamicRange: "bt709",
      fingerprint: "ambiguous|3600|1920|1080|h264|aac",
    });
    const better = insertFileRecord({
      ownerId: ownerA,
      filename: "Ambiguous.2025.2160p.mkv",
      path: "D:\\Movies\\Ambiguous.2025.2160p.mkv",
      identityKey: "movie:ambiguous:2025",
      checksum: "6d".padEnd(64, "f"),
      sizeBytes: 11_700_000_000,
      height: 2160,
      width: 3840,
      durationSeconds: 3600,
      videoCodec: "hevc",
      audioCodec: "eac3",
      audioChannels: 6,
      bitrate: 26_000_000,
      dynamicRange: "smpte2084",
      fingerprint: "ambiguous|3600|3840|2160|hevc|eac3",
    });
    freshOwnerScope();

    const response = readQualityFindings(ownerA);
    const onGroup = response.results.filter(
      (finding) => [twinA, twinB, better].includes(finding.fileRecordId),
    );
    // The two identical copies are reported once as duplicates, and the group of
    // distinct encodes still has a defensible winner instead of a stalemate.
    assert.ok(!onGroup.some((finding) => finding.kind === "materially_different_encode"));
    assert.deepEqual(
      onGroup.filter((finding) => finding.kind === "superior_encode").map((finding) => finding.fileRecordId),
      [better],
    );
    // Encode findings attach to one canonical record per duplicate set, so the
    // identical copy is not double-reported as its own lower-quality version.
    assert.deepEqual(
      onGroup
        .filter((finding) => finding.kind === "lower_quality_duplicate")
        .map((finding) => finding.fileRecordId),
      [twinA],
    );
    assert.equal(
      onGroup.filter((finding) => finding.kind === "exact_duplicate").length,
      2,
    );

    // Location is reported where the bytes live, not by repeating filenames.
    const lowerQuality = onGroup.find((finding) => finding.kind === "lower_quality_duplicate");
    const locationAxis = lowerQuality?.axes.find((axis) => axis.axis === "location");
    assert.equal(locationAxis?.materiality, "informational");
    assert.equal(locationAxis?.leftValue, "D:\\Movies");
    assert.equal(lowerQuality?.currentQuality.storageScope, "library");
  });

  test("the record report exposes the model, the comparisons, and the findings", () => {
    const id = insertFileRecord({
      ownerId: ownerA,
      filename: "Report.2025.1080p.mkv",
      path: "D:\\Movies\\Report.2025.1080p.mkv",
      identityKey: "movie:report:2025",
      checksum: "33".padEnd(64, "c"),
      sizeBytes: 800_000_000,
      height: 1080,
      width: 1920,
      durationSeconds: 3000,
      videoCodec: "h264",
      audioCodec: "aac",
      audioChannels: 2,
      bitrate: 2_000_000,
      dynamicRange: "bt709",
      fingerprint: "report|3000|1920|1080|h264|aac",
    });
    insertFileRecord({
      ownerId: ownerA,
      filename: "Report.2025.2160p.mkv",
      path: "D:\\Movies\\Report.2025.2160p.mkv",
      identityKey: "movie:report:2025",
      checksum: "44".padEnd(64, "d"),
      sizeBytes: 9_750_000_000,
      height: 2160,
      width: 3840,
      durationSeconds: 3000,
      videoCodec: "hevc",
      audioCodec: "eac3",
      audioChannels: 6,
      bitrate: 26_000_000,
      dynamicRange: "smpte2084",
      fingerprint: "report|3000|3840|2160|hevc|eac3",
    });
    freshOwnerScope();

    const report = readRecordQualityReport(ownerA, id);
    assert.ok(report);
    assert.equal(report.fileRecordId, id);
    assert.equal(report.identityKey, "movie:report:2025");
    assert.equal(report.currentQuality.resolution, "1080p");
    assert.equal(report.currentQuality.dynamicRange, "sdr");
    assert.match(report.currentQualityLine, /1080p/);
    assert.equal(report.comparisons.length, 1);
    assert.equal(report.comparisons[0]?.relationship, "inferior_encode");
    assert.equal(report.comparisons[0]?.winner, "right");
    assert.equal(report.action, "review_only");
    assert.ok(report.findings.length > 0);
    assert.equal(readRecordQualityReport(ownerA, 999_999), null);
  });

  test("system events stay available to the archive owner after quality analysis", () => {
    addEvent("info", "quality analysis recorded an event", "archive-quality", ownerA);
    const events = archiveDb.prepare(
      "SELECT message FROM system_event WHERE owner_id = ? AND source = 'archive-quality'",
    ).all(ownerA) as Array<{ message: string }>;
    assert.ok(events.some((event) => event.message === "quality analysis recorded an event"));
  });
});
