import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { archiveDb, addEvent, readSettings, type SettingsRecord } from "../lib/archive-db";
import { inspectLocalMedia } from "./media";
import { getArchiveScanRoots, isArchivePathWithin } from "./storage";
import {
  coarseQualityScore,
  compareEncodes,
  legacyQualityDifferences,
  technicalQualityFromPlexItemRow,
  technicalQualityFromRecord,
  type TechnicalQuality,
} from "./media-quality";

const supportedExtensions = new Set([
  ".avi", ".flac", ".m4a", ".m4v", ".mkv", ".mov", ".mp3", ".mp4",
  ".mpeg", ".mpg", ".ogg", ".ogv", ".ts", ".wav", ".webm", ".wmv",
]);
const scans = new Map<string, Promise<void>>();
const inventoryCache = new Map<string, ReturnType<typeof buildArchiveInventory>>();

type ScanStatus = "not_scanned" | "scanning" | "completed" | "failed";
type FileStatus = "active" | "missing" | "error";
type QualityStatus =
  | "best_local_version"
  | "lower_quality_version"
  | "higher_quality_available"
  | "duplicate"
  | "plex_version_exists"
  | "local_only"
  | "file_missing"
  | "needs_review";
type ReviewStatus = "not_applicable" | "unreviewed" | "reviewed" | "deferred" | "unresolved";
type SavedReviewStatus = Exclude<ReviewStatus, "not_applicable" | "unreviewed">;
const reviewableQualityStatuses = new Set<QualityStatus>([
  "duplicate",
  "lower_quality_version",
  "higher_quality_available",
  "file_missing",
  "needs_review",
]);

type FileRow = {
  id: number;
  archive_item_id: number | null;
  filename: string;
  path: string;
  relative_path: string;
  size_bytes: number | null;
  checksum: string | null;
  media_type: string | null;
  scan_status: FileStatus;
  error_message: string | null;
  duration_seconds: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrate: number | null;
  container: string | null;
  dynamic_range: string | null;
  audio_channels: number | null;
  audio_languages: string;
  subtitle_languages: string;
  fingerprint: string | null;
  modified_at_ms: number | null;
  last_seen_at: string | null;
  local_identity_id?: number | null;
  volume_id?: string | null;
  archive_root?: string | null;
  video_profile?: string | null;
  video_pix_fmt?: string | null;
  video_bit_depth?: number | null;
  color_primaries?: string | null;
  audio_profile?: string | null;
  audio_channel_layout?: string | null;
  video_bitrate?: number | null;
  audio_bitrate?: number | null;
  audio_tracks?: string | null;
  subtitle_tracks?: string | null;
  checksum_status?: string | null;
  identity_key?: string | null;
};

type LocalMediaIdentity = {
  id: number;
  identity_key: string;
  media_type: string;
  normalized_title: string;
  year: number | null;
  show_identity: string | null;
  season_number: number | null;
  episode_number: number | null;
  size_bytes: number | null;
  fingerprint: string | null;
  checksum: string | null;
};

type PlexRow = {
  id: number;
  rating_key: string;
  title: string;
  item_type: string;
  year: number | null;
  metadata_json: string;
  video_resolution: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  bitrate: number | null;
};

/**
 * The normalized technical-quality model is the single source of truth for
 * comparisons. `file_record` rows and cached Plex rows are both converted into
 * it (see `media-quality.ts`), so the inventory and the findings layer never
 * disagree about what a file is.
 */
type QualityShape = TechnicalQuality;

/**
 * The coarse ranking shape the reconciliation path (`pickBetterQuality`) and the
 * acquisition engine were written against. The quality findings layer ranks
 * through `coarseQualityScore` on the normalized model instead; this adapter
 * delegates to that one scoring function rather than repeating its weights, so
 * the score lives in one place conceptually. The weights below are the model's
 * `coarseQualityScore` expressed on this narrower shape, and `quality.test.ts`
 * pins the two together so they cannot drift apart unnoticed. `hdr` is the only
 * field with no model counterpart: a plain boolean means "any non-SDR range",
 * which is exactly what the score keys on.
 */
export type LegacyQualityShape = {
  height: number | null;
  hdr: boolean;
  videoCodec: string | null;
  bitrate: number | null;
  audioCodec: string | null;
  audioChannels: number | null;
  container: string | null;
};

export function qualityRank(shape: LegacyQualityShape) {
  const height = shape.height ?? 0;
  const hdr = shape.hdr ? 5000 : 0;
  const codec = /av1/i.test(shape.videoCodec ?? "")
    ? 300
    : /265|hevc/i.test(shape.videoCodec ?? "")
      ? 250
      : /264/i.test(shape.videoCodec ?? "")
        ? 150
        : 50;
  const bitrate = Math.min(100, Math.round((shape.bitrate ?? 0) / 1_000_000));
  const audio = shape.audioChannels ?? 0;
  return height + hdr + codec + bitrate + audio;
}

function expandPath(value: string) {
  return value.startsWith("~/")
    ? resolve(process.env.HOME ?? process.cwd(), value.slice(2))
    : resolve(value);
}

function parseJsonArray(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function normalizeTitle(value: string) {
  const normalized = value
    .replace(/\.[^.]+$/, "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/\b(4k|uhd|2160p?|1080p?|720p?|480p?|bluray|web[ ._-]?dl|x26[45]|h26[45]|hevc|av1)\b/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (normalized) return normalized;
  const year = value.match(/\b((?:19|20)\d{2})\b/);
  return year?.[1] ?? "";
}

export function titleYear(value: string) {
  const matches = [...value.matchAll(/\b((?:19|20)\d{2})\b/g)];
  return matches.length ? Number(matches.at(-1)?.[1]) : null;
}

export function archiveVolumeId(root: string) {
  const normalized = root.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  if (normalized === "d:\\movies") return "d-movies";
  if (normalized === "d:\\tv shows") return "d-tv";
  if (normalized === "e:\\movies") return "e-movies";
  if (normalized === "e:\\tv shows") return "e-tv";
  return `configured:${normalized}`;
}

function localIdentityFor(
  filename: string,
  root: string,
  sizeBytes: number | null,
  fingerprint: string | null,
  checksum: string | null,
) {
  const mediaType = /(^|[\\/])tv shows?([\\/]|$)/i.test(root) ? "tv" : "movie";
  const episode = mediaType === "tv" ? localEpisodeIdentity(filename) : null;
  const year = titleYear(filename);
  const normalizedTitle = episode?.show ?? normalizeTitle(filename);
  const identityKey = episode
    ? `tv:${episode.show}:${episode.season}:${episode.episode}`
    : `movie:${normalizedTitle}:${year ?? ""}`;
  return {
    identityKey,
    mediaType,
    normalizedTitle,
    year,
    showIdentity: episode?.show ?? null,
    seasonNumber: episode?.season ?? null,
    episodeNumber: episode?.episode ?? null,
    sizeBytes,
    fingerprint,
    checksum,
  };
}

function qualityOf(row: FileRow, indexes: InventoryIndexes): QualityShape {
  const known = indexes.quality.get(row.id);
  if (known) return known;
  return technicalQualityFromRecord(row);
}

function plexQualityShape(row: PlexRow, indexes: InventoryIndexes): QualityShape {
  const known = indexes.plexQuality.get(row.id);
  if (known) return known;
  return technicalQualityFromPlexItemRow({
    id: row.id,
    ratingKey: row.rating_key,
    title: row.title,
    metadataJson: row.metadata_json,
    videoResolution: row.video_resolution,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    bitrateKbps: row.bitrate,
  });
}

export function upsertLocalIdentity(ownerId: string, localIdentity: ReturnType<typeof localIdentityFor>): number {
  archiveDb.prepare(`
    INSERT INTO local_media_identity
      (owner_id, identity_key, media_type, normalized_title, year, show_identity,
       season_number, episode_number, size_bytes, fingerprint, checksum, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(owner_id, identity_key) DO UPDATE SET
      media_type = excluded.media_type,
      normalized_title = excluded.normalized_title,
      year = excluded.year,
      show_identity = excluded.show_identity,
      season_number = excluded.season_number,
      episode_number = excluded.episode_number,
      size_bytes = excluded.size_bytes,
      fingerprint = excluded.fingerprint,
      checksum = excluded.checksum,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    ownerId,
    localIdentity.identityKey,
    localIdentity.mediaType,
    localIdentity.normalizedTitle,
    localIdentity.year,
    localIdentity.showIdentity,
    localIdentity.seasonNumber,
    localIdentity.episodeNumber,
    localIdentity.sizeBytes,
    localIdentity.fingerprint,
    localIdentity.checksum,
  );
  // SQLite does not advance last_insert_rowid() on the upsert-update path, so
  // the id must be read back; otherwise a second file sharing this identity
  // would be linked to a stale, unrelated identity row.
  const identity = archiveDb.prepare(
    "SELECT id FROM local_media_identity WHERE owner_id = ? AND identity_key = ?",
  ).get(ownerId, localIdentity.identityKey) as { id: number } | undefined;
  if (!identity) {
    throw new Error(`Local media identity row could not be resolved for key '${localIdentity.identityKey}'.`);
  }
  return identity.id;
}

function reviewEvidenceKey(record: {
  qualityStatus: QualityStatus;
  checksum: string | null;
  fingerprint?: string | null;
  duplicateOfId: number | null;
  qualityDifferences: string[];
  plexMatch: { ratingKey: string } | null;
}) {
  return createHash("sha256").update(JSON.stringify({
    qualityStatus: record.qualityStatus,
    checksum: record.checksum,
    fingerprint: record.fingerprint ?? null,
    duplicateOfId: record.duplicateOfId,
    qualityDifferences: record.qualityDifferences,
    plexRatingKey: record.plexMatch?.ratingKey ?? null,
  })).digest("hex");
}

type ReviewRow = {
  status: SavedReviewStatus;
  note: string | null;
  updated_at: string;
};

function readReview(ownerId: string, fileRecordId: number, findingType: QualityStatus, evidenceKey: string, reviews: Map<string, ReviewRow>) {
  if (!reviewableQualityStatuses.has(findingType)) {
    return { status: "not_applicable" as const, note: null, updatedAt: null };
  }
  const row = reviews.get(`${ownerId}:${fileRecordId}:${findingType}:${evidenceKey}`);
  return row
    ? { status: row.status, note: row.note, updatedAt: row.updated_at }
    : { status: "unreviewed" as const, note: null, updatedAt: null };
}

function parseMetadata(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function checksum(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function* walk(root: string, onWarning: (message: string) => void): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    onWarning(`Archive scan skipped directory ${root}: ${error instanceof Error ? error.message : "directory could not be read"}`);
    return;
  }
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path, onWarning);
    } else if (entry.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase())) {
      yield path;
    }
  }
}

type ChecksumOutcome = {
  checksum: string | null;
  checksumStatus: "computed" | "failed" | "not_computed";
};

/**
 * Scan roots are the configured archive volumes plus the download staging
 * directory when it exists. Staging has to be inventoried too, otherwise a
 * freshly downloaded copy of something already in the library stays invisible
 * to duplicate and quality comparison until it is moved.
 */
function scanRoots(settings: SettingsRecord) {
  const volumeRoots = getArchiveScanRoots(settings);
  const roots: Array<{ path: string; optional: boolean }> = volumeRoots.map((path) => ({ path, optional: false }));
  // The download staging directory is inventoried like archive volumes so
  // completed and in-flight downloads are visible to dedupe, reconciliation,
  // and naming intelligence. It is optional: a missing directory simply
  // contributes nothing instead of failing the scan. Nested or overlapping
  // roots are skipped to avoid double-walking the same tree.
  const downloadRoot = settings.downloadDirectory?.trim();
  if (downloadRoot) {
    const expanded = expandPath(downloadRoot);
    const alreadyCovered = volumeRoots.some(
      (root) => isArchivePathWithin(expanded, root) || isArchivePathWithin(root, expanded),
    );
    if (!alreadyCovered) {
      roots.push({ path: expanded, optional: true });
    }
  }
  return roots;
}

function updateScan(ownerId: string, values: Record<string, unknown>) {
  archiveDb.prepare(
    `INSERT INTO archive_scan (owner_id, updated_at)
     VALUES (?, CURRENT_TIMESTAMP)
     ON CONFLICT(owner_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
  ).run(ownerId);
  const assignments = Object.keys(values).map((key) => `${key} = ?`).join(", ");
  archiveDb.prepare(
    `UPDATE archive_scan SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE owner_id = ?`,
  ).run(...Object.values(values) as Array<string | number | null>, ownerId);
}

function fingerprintFor(filename: string, inspected: { durationSeconds: number | null; width: number | null; height: number | null; videoCodec: string | null; audioCodec: string | null } | null) {
  if (!inspected) return null;
  return [
    normalizeTitle(filename),
    inspected.durationSeconds === null ? "unknown" : Math.round(inspected.durationSeconds),
    inspected.width ?? "unknown",
    inspected.height ?? "unknown",
    inspected.videoCodec ?? "unknown",
    inspected.audioCodec ?? "unknown",
  ].join("|");
}

export function localIdentityForPath(filename: string, root: string, sizeBytes: number | null, fingerprint: string | null, checksum: string | null) {
  return localIdentityFor(filename, root, sizeBytes, fingerprint, checksum);
}

function upsertArchiveRecord(
  ownerId: string,
  filePath: string,
  root: string,
  modifiedAtMs: number,
  inspected: Awaited<ReturnType<typeof inspectLocalMedia>> | null,
  fileChecksum: string | null,
  errorMessage: string | null,
  checksumStatus: ChecksumOutcome["checksumStatus"] = fileChecksum ? "computed" : "not_computed",
) {
  const filename = basename(filePath);
  const relativePath = relative(root, filePath);
  const title = filename.replace(/\.[^.]+$/, "");
  const fingerprint = fingerprintFor(filename, inspected);
  const localIdentity = localIdentityFor(filename, root, inspected?.filesize ?? null, fingerprint, fileChecksum);
  // The identity row is an upsert, and SQLite does not advance
  // `last_insert_rowid` on the DO UPDATE branch, so the id is always read back
  // by (owner_id, identity_key) - see `upsertLocalIdentity`.
  const localIdentityId = upsertLocalIdentity(ownerId, localIdentity);

  const existingItem = archiveDb.prepare(
    "SELECT id FROM archive_item WHERE owner_id = ? AND archive_path = ?",
  ).get(ownerId, filePath) as { id: number } | undefined;
  const archiveItemId = existingItem?.id ?? Number(archiveDb.prepare(
    "INSERT INTO archive_item (title, status, archive_path, owner_id) VALUES (?, 'inventory', ?, ?)",
  ).run(title, filePath, ownerId).lastInsertRowid);
  if (existingItem) {
    archiveDb.prepare(
      "UPDATE archive_item SET title = ?, status = 'inventory', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?",
    ).run(title, existingItem.id, ownerId);
  }
  archiveDb.prepare(
    `INSERT INTO file_record
        (path, size_bytes, checksum, media_type, owner_id, archive_item_id, filename, relative_path,
         local_identity_id, volume_id, archive_root,
         scan_status, last_seen_at, modified_at_ms, extension, duration_seconds, video_codec, audio_codec,
         width, height, fps, bitrate, container, dynamic_range, audio_channels, audio_languages,
         subtitle_languages, fingerprint, error_message,
         video_profile, video_pix_fmt, video_bit_depth, color_primaries, audio_profile,
         audio_channel_layout, video_bitrate, audio_bitrate, audio_tracks, subtitle_tracks,
         checksum_status, updated_at)
       VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?,
         ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
       )
       ON CONFLICT(owner_id, path) DO UPDATE SET
         size_bytes = excluded.size_bytes, checksum = excluded.checksum, media_type = excluded.media_type,
         archive_item_id = excluded.archive_item_id, filename = excluded.filename, relative_path = excluded.relative_path,
         local_identity_id = excluded.local_identity_id, volume_id = excluded.volume_id, archive_root = excluded.archive_root,
         scan_status = excluded.scan_status, last_seen_at = excluded.last_seen_at, modified_at_ms = excluded.modified_at_ms,
         extension = excluded.extension, duration_seconds = excluded.duration_seconds, video_codec = excluded.video_codec,
         audio_codec = excluded.audio_codec, width = excluded.width, height = excluded.height, fps = excluded.fps,
         bitrate = excluded.bitrate, container = excluded.container, dynamic_range = excluded.dynamic_range,
         audio_channels = excluded.audio_channels, audio_languages = excluded.audio_languages,
         subtitle_languages = excluded.subtitle_languages, fingerprint = excluded.fingerprint,
         error_message = excluded.error_message,
         video_profile = excluded.video_profile, video_pix_fmt = excluded.video_pix_fmt,
         video_bit_depth = excluded.video_bit_depth, color_primaries = excluded.color_primaries,
         audio_profile = excluded.audio_profile, audio_channel_layout = excluded.audio_channel_layout,
         video_bitrate = excluded.video_bitrate, audio_bitrate = excluded.audio_bitrate,
         audio_tracks = excluded.audio_tracks, subtitle_tracks = excluded.subtitle_tracks,
         checksum_status = excluded.checksum_status, updated_at = CURRENT_TIMESTAMP`,
  ).run(
   filePath,
   inspected?.filesize ?? null,
   fileChecksum,
   inspected?.container ?? null,
   ownerId,
   archiveItemId,
   filename,
   relativePath,
   localIdentityId,
   archiveVolumeId(root),
   root,
   inspected ? "active" : "error",
   modifiedAtMs,
   extname(filename).slice(1).toLowerCase(),
   inspected?.durationSeconds ?? null,
   inspected?.videoCodec ?? null,
   inspected?.audioCodec ?? null,
   inspected?.width ?? null,
   inspected?.height ?? null,
   inspected?.fps ?? null,
   inspected?.bitrate ?? null,
   inspected?.container ?? null,
   inspected?.dynamicRange ?? null,
   inspected?.audioChannels ?? null,
   JSON.stringify(inspected?.audioLanguages ?? []),
   JSON.stringify(inspected?.subtitleLanguages ?? []),
   fingerprint,
   errorMessage,
   inspected?.videoProfile ?? null,
   inspected?.videoPixFmt ?? null,
   inspected?.videoBitDepth ?? null,
   inspected?.colorPrimaries ?? null,
   inspected?.audioProfile ?? null,
   inspected?.audioChannelLayout ?? null,
   inspected?.videoBitrate ?? null,
   inspected?.audioBitrate ?? null,
   JSON.stringify(inspected?.audioTracks ?? []),
   JSON.stringify(inspected?.subtitleTracks ?? []),
   checksumStatus,
  );
}

/**
 * Hashes one file with the checksum logic that already existed in this module.
 *
 * The scanner previously left `file_record.checksum` permanently NULL, which
 * meant `exact_duplicate` could never be reported: the byte-level index was
 * always empty and every duplicate fell back to the coarse fingerprint. A
 * checksum is now produced whenever a file is (re-)inspected, and back-filled
 * once for records that were scanned before this existed.
 *
 * Hashing is only paid for new or changed files: the size + mtime short circuit
 * below keeps already-verified records at zero cost.
 */
async function computeChecksum(filePath: string): Promise<ChecksumOutcome> {
  try {
    return { checksum: await checksum(filePath), checksumStatus: "computed" };
  } catch {
    return { checksum: null, checksumStatus: "failed" };
  }
}

async function inspectFile(filePath: string, root: string, existing: FileRow | undefined, settings: SettingsRecord, archiveScanRoots: string[]) {
  const fileStats = await stat(filePath);
  // The unchanged fast path skips re-inspection and re-hashing entirely. Rows
  // recorded before checksum capture was reconnected return to a null
  // checksum, so they are inspected once more to attach duplicate evidence.
  const unchanged = existing
    && existing.scan_status === "active"
    && existing.size_bytes === fileStats.size
    && existing.modified_at_ms === Math.trunc(fileStats.mtimeMs)
    && existing.checksum;
  if (unchanged) {
    // Metadata is still valid, so FFprobe is skipped. Byte-level evidence is
    // the one thing older scans never stored, so back-fill it without probing.
    const backfill = existing.checksum ? null : await computeChecksum(filePath);
    return {
      filePath,
      root,
      modifiedAtMs: Math.trunc(fileStats.mtimeMs),
      inspected: null,
      fileChecksum: existing.checksum ?? backfill?.checksum ?? null,
      checksumStatus: existing.checksum
        ? "computed" as const
        : backfill?.checksumStatus ?? "not_computed" as const,
      errorMessage: null,
      unchangedRecordId: existing.id,
      checksumBackfill: backfill,
      warningMessage: undefined,
    };
  }

  let inspected: Awaited<ReturnType<typeof inspectLocalMedia>> | null = null;
  let errorMessage: string | null = null;
  try {
    inspected = await inspectLocalMedia(filePath, settings, archiveScanRoots);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "The file could not be inspected.";
  }
  // The hash is independent of FFprobe success: an unprobeable file still has
  // byte-level identity, and a duplicate of it is still an exact duplicate.
  const hashed = await computeChecksum(filePath);

  // A failed hash degrades duplicate evidence only, but the operator should
  // still see why exact-duplicate findings are unavailable for this file.
  if (hashed.checksumStatus === "failed" && !errorMessage) {
    errorMessage = "The file could not be hashed for duplicate evidence.";
  }
  return {
    filePath,
    root,
    modifiedAtMs: Math.trunc(fileStats.mtimeMs),
    inspected,
    fileChecksum: hashed.checksum,
    checksumStatus: hashed.checksumStatus,
    errorMessage,
    unchangedRecordId: null,
    checksumBackfill: null,
    warningMessage: undefined,
  };
}

async function scanArchive(ownerId: string) {
  invalidateArchiveInventoryCache(ownerId);
  const settings = readSettings();
  const scanRootList = scanRoots(settings);
  const roots = scanRootList.map((root) => root.path);
  const found = new Set<string>();
  let scannedFiles = 0;
  let failedFiles = 0;
  let rootError: string | null = null;
  const traversalWarnings: string[] = [];
  updateScan(ownerId, {
    status: "scanning",
    started_at: new Date().toISOString(),
    completed_at: null,
    last_error: null,
    scanned_files: 0,
    failed_files: 0,
  });

const concurrency = Math.max(
  1,
  Math.min(8, Math.trunc(settings.archiveScanConcurrency ?? 4)),
);
  const existingRows = archiveDb.prepare(
    "SELECT * FROM file_record WHERE owner_id = ?",
  ).all(ownerId) as FileRow[];
  const existingByPath = new Map(existingRows.map((row) => [row.path, row]));

for (const { path: root, optional } of scanRootList) {
  try {
    await access(root);
  } catch (error) {
    if (optional) {
      // An unmounted or unused download staging directory is not an error for
      // the inventory scan; there is simply nothing to walk.
      continue;
    }
    rootError = `${root}: ${error instanceof Error ? error.message : "directory could not be read"}`;
    failedFiles += 1;
    continue;
  }
  try {
    const batch: string[] = [];

    const processBatch = async () => {
      if (!batch.length) return;

      const files = batch.splice(0, batch.length);

      const results = await Promise.all(
        files.map(async (filePath) => {
          found.add(filePath);

          try {
            return {
              filePath,
              result: await inspectFile(filePath, root, existingByPath.get(filePath), settings, roots),
            };
          } catch (error) {
            return {
              filePath,
              result: {
                filePath,
                root,
                modifiedAtMs: 0,
                inspected: null,
                fileChecksum: null,
                checksumStatus: "not_computed" as const,
                errorMessage: null,
                unchangedRecordId: null,
                checksumBackfill: null,
                warningMessage: `Archive scan could not inspect ${basename(filePath)}: ${
                  error instanceof Error ? error.message : "unknown error"
                }`,
              },
            };
          }
        }),
      );

      const warnings: string[] = [];
      archiveDb.exec("BEGIN IMMEDIATE");
      try {
        for (const { result } of results) {
          if (result.warningMessage) {
            failedFiles += 1;
            warnings.push(result.warningMessage);
          } else {
            try {
              if (result.unchangedRecordId !== null) {
                if (result.checksumBackfill?.checksum) {
                  archiveDb.prepare(
                    "UPDATE file_record SET checksum = ?, checksum_status = ?, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?",
                  ).run(result.checksumBackfill.checksum, result.checksumBackfill.checksumStatus, result.unchangedRecordId, ownerId);
                  archiveDb.prepare(
                    "UPDATE local_media_identity SET checksum = COALESCE(?, checksum), updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT local_identity_id FROM file_record WHERE id = ?)",
                  ).run(result.checksumBackfill.checksum, result.unchangedRecordId);
                } else {
                  archiveDb.prepare(
                    "UPDATE file_record SET last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?",
                  ).run(result.unchangedRecordId, ownerId);
                }
              } else {
                upsertArchiveRecord(
                  ownerId,
                  result.filePath,
                  result.root,
                  result.modifiedAtMs,
                  result.inspected,
                  result.fileChecksum,
                  result.errorMessage,
                  result.checksumStatus,
                );
                if (result.inspected === null) failedFiles += 1;
              }
            } catch (error) {
              failedFiles += 1;
              warnings.push(`Archive scan could not inspect ${basename(result.filePath)}: ${
                error instanceof Error ? error.message : "unknown error"
              }`);
            }
          }
          scannedFiles += 1;
        }
        updateScan(ownerId, {
          scanned_files: scannedFiles,
          failed_files: failedFiles,
        });
        archiveDb.exec("COMMIT");
      } catch (error) {
        archiveDb.exec("ROLLBACK");
        throw error;
      }
      for (const warning of warnings) {
        addEvent("warning", warning, "archive", ownerId);
      }
    };

    for await (const filePath of walk(root, (message) => traversalWarnings.push(message))) {
      batch.push(filePath);

      if (batch.length >= concurrency) {
        await processBatch();
      }
    }

    await processBatch();
  } catch (error) {
    rootError = `${root}: ${
      error instanceof Error ? error.message : "directory could not be read"
    }`;
    failedFiles += 1;
  }
}
  archiveDb.exec("BEGIN IMMEDIATE");
  try {
    const existing = archiveDb.prepare(
      "SELECT id, path FROM file_record WHERE owner_id = ?",
    ).all(ownerId) as Array<{ id: number; path: string }>;
    for (const row of existing) {
      if (roots.some((root) => row.path === root || row.path.startsWith(`${root}${sep}`)) && !found.has(row.path)) {
        archiveDb.prepare(
          "UPDATE file_record SET scan_status = 'missing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?",
        ).run(row.id, ownerId);
      }
    }
    archiveDb.exec("COMMIT");
  } catch (error) {
    archiveDb.exec("ROLLBACK");
    throw error;
  }

  for (const warning of traversalWarnings) {
    addEvent("warning", warning, "archive", ownerId);
  }

  invalidateArchiveInventoryCache(ownerId);
  const final = readArchiveInventory(ownerId);
  const error = rootError ?? (failedFiles ? `Scan completed with ${failedFiles} file${failedFiles === 1 ? "" : "s"} that could not be inspected.` : null);
  updateScan(ownerId, {
    status: rootError ? "failed" : "completed",
    completed_at: new Date().toISOString(),
    last_error: error,
    scanned_files: scannedFiles,
    active_files: final.summary.activeFiles,
    failed_files: failedFiles,
    duplicate_count: final.summary.duplicateCount,
    missing_count: final.summary.missingCount,
    quality_conflict_count: final.summary.qualityConflictCount,
    plex_only_count: final.summary.plexOnlyCount,
    local_only_count: final.summary.localOnlyCount,
  });
}

export function startArchiveScan(ownerId: string) {
  const existing = scans.get(ownerId);
  const currentState = readArchiveScan(ownerId);
  if (existing && currentState.status === "scanning") return currentState;
  let promise: Promise<void>;
  promise = scanArchive(ownerId)
    .catch((error) => {
      updateScan(ownerId, {
        status: "failed",
        completed_at: new Date().toISOString(),
        last_error: error instanceof Error ? error.message : "Archive scan failed unexpectedly.",
      });
      addEvent("error", "Archive scan failed unexpectedly.", "archive", ownerId);
    })
    .finally(() => {
      if (scans.get(ownerId) === promise) scans.delete(ownerId);
    });
  scans.set(ownerId, promise);
  return readArchiveScan(ownerId);
}

export function readArchiveScan(ownerId: string) {
  const row = archiveDb.prepare(
    "SELECT status, started_at, completed_at, last_error, scanned_files, active_files, failed_files, duplicate_count, missing_count, quality_conflict_count, plex_only_count, local_only_count FROM archive_scan WHERE owner_id = ?",
  ).get(ownerId) as {
    status: ScanStatus;
    started_at: string | null;
    completed_at: string | null;
    last_error: string | null;
    scanned_files: number;
    active_files: number;
    failed_files: number;
    duplicate_count: number;
    missing_count: number;
    quality_conflict_count: number;
    plex_only_count: number;
    local_only_count: number;
  } | undefined;
  return {
    status: row?.status ?? "not_scanned" as const,
    startedAt: row?.started_at ?? null,
    completedAt: row?.completed_at ?? null,
    lastError: row?.last_error ?? null,
    scannedFiles: row?.scanned_files ?? 0,
    activeFiles: row?.active_files ?? 0,
    failedFiles: row?.failed_files ?? 0,
    duplicateCount: row?.duplicate_count ?? 0,
    missingCount: row?.missing_count ?? 0,
    qualityConflictCount: row?.quality_conflict_count ?? 0,
    plexOnlyCount: row?.plex_only_count ?? 0,
    localOnlyCount: row?.local_only_count ?? 0,
  };
}

function readPlexRows(ownerId: string) {
  return archiveDb.prepare(
    `SELECT pi.id, pi.rating_key, pi.title, pi.item_type, pi.year, pi.metadata_json,
            pm.video_resolution, pm.video_codec, pm.audio_codec, pm.bitrate
     FROM plex_item pi
     LEFT JOIN plex_media pm ON pm.item_id = pi.id
     WHERE pi.owner_id = ?
     ORDER BY pi.title COLLATE NOCASE`,
  ).all(ownerId) as PlexRow[];
}

type EpisodeIdentity = {
  show: string;
  season: number;
  episode: number;
};

export function localEpisodeIdentity(filename: string): EpisodeIdentity | null {
  const name = filename.replace(/\.[^.]+$/, "");
  const match = name.match(/^(.+?)[\s._-]+(?:S(\d{1,2})[\s._-]*E(\d{1,2})|(\d{1,2})x(\d{1,2}))(?=E\d{1,2}(?:[\s._-]|$)|[\s._-]|$)/i);
  if (!match) return null;
  const show = normalizeTitle(`${match[1]}.mkv`);
  const season = Number(match[2] ?? match[4]);
  const episode = Number(match[3] ?? match[5]);
  return show && Number.isInteger(season) && Number.isInteger(episode)
    ? { show, season, episode }
    : null;
}

function episodeIdentityKey(identity: EpisodeIdentity) {
  return `${identity.show}:${identity.season}:${identity.episode}`;
}

function plexEpisodeIndex(plexRows: PlexRow[]) {
  const index = new Map<string, PlexRow>();
  for (const row of plexRows) {
    if (row.item_type !== "episode") continue;
    const metadata = asRecord(parseMetadata(row.metadata_json));
    const show = typeof metadata.grandparentTitle === "string"
      ? normalizeTitle(metadata.grandparentTitle)
      : "";
    const season = Number(metadata.parentIndex);
    const episode = Number(metadata.index);
    if (!show || !Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) continue;
    const key = episodeIdentityKey({ show, season, episode });
    if (!index.has(key)) index.set(key, row);
  }
  return index;
}

type PlexTitleIndexes = {
  byTitle: Map<string, PlexRow[]>;
  byTitleAndYear: Map<string, PlexRow[]>;
  byTitleWithoutYear: Map<string, PlexRow[]>;
  order: Map<PlexRow, number>;
};

function plexTitleIndexes(plexRows: PlexRow[]): PlexTitleIndexes {
  const byTitle = new Map<string, PlexRow[]>();
  const byTitleAndYear = new Map<string, PlexRow[]>();
  const byTitleWithoutYear = new Map<string, PlexRow[]>();
  const order = new Map<PlexRow, number>();
  for (const [index, plex] of plexRows.entries()) {
    order.set(plex, index);
    const title = normalizeTitle(plex.title);
    if (!title) continue;
    const titleRows = byTitle.get(title) ?? [];
    titleRows.push(plex);
    byTitle.set(title, titleRows);
    if (plex.year === null) {
      const rowsWithoutYear = byTitleWithoutYear.get(title) ?? [];
      rowsWithoutYear.push(plex);
      byTitleWithoutYear.set(title, rowsWithoutYear);
    } else {
      const titleYearKey = `${title}:${plex.year}`;
      const rowsForYear = byTitleAndYear.get(titleYearKey) ?? [];
      rowsForYear.push(plex);
      byTitleAndYear.set(titleYearKey, rowsForYear);
    }
  }
  return { byTitle, byTitleAndYear, byTitleWithoutYear, order };
}

function plexMatch(row: FileRow, indexes: PlexTitleIndexes, episodeIndex: Map<string, PlexRow>, localIdentity?: LocalMediaIdentity) {
  if (localIdentity) {
    if (localIdentity.media_type === "tv") {
      const { show_identity: show, season_number: season, episode_number: episode } = localIdentity;
      if (show && typeof season === "number" && typeof episode === "number") {
        return episodeIndex.get(episodeIdentityKey({ show, season, episode }));
      }
    }
    if (localIdentity.media_type === "movie") {
      const localTitle = localIdentity.normalized_title;
      const localYear = localIdentity.year;
      if (localYear === null) return indexes.byTitle.get(localTitle)?.[0];
      const exactYearRows = indexes.byTitleAndYear.get(`${localTitle}:${localYear}`) ?? [];
      const missingYearRows = indexes.byTitleWithoutYear.get(localTitle) ?? [];
      const candidates = [...exactYearRows, ...missingYearRows];
      return candidates.length ? candidates.reduce((first, candidate) => {
        if (!first) return candidate;
        return indexes.order.get(candidate)! < indexes.order.get(first)! ? candidate : first;
      }, candidates[0]) : undefined;
    }
  }
  const episode = localEpisodeIdentity(row.filename);
  if (episode) {
    const episodeMatch = episodeIndex.get(episodeIdentityKey(episode));
    if (episodeMatch) return episodeMatch;
  }
  const localTitle = normalizeTitle(row.filename);
  const localYear = titleYear(row.filename);
  if (localYear === null) return indexes.byTitle.get(localTitle)?.[0];
  const exactYearRows = indexes.byTitleAndYear.get(`${localTitle}:${localYear}`) ?? [];
  const missingYearRows = indexes.byTitleWithoutYear.get(localTitle) ?? [];
  const candidates = [...exactYearRows, ...missingYearRows];
  return candidates.length ? candidates.reduce((first, candidate) => {
    if (!first) return candidate;
    return indexes.order.get(candidate)! < indexes.order.get(first)! ? candidate : first;
  }, candidates[0]) : undefined;
}

function mapFile(ownerId: string, row: FileRow, indexes: InventoryIndexes, plexRows: PlexRow[], episodeIndex: Map<string, PlexRow>, plexTitleIndex: PlexTitleIndexes, reviews: Map<string, ReviewRow>, localIdentity?: LocalMediaIdentity) {
  const identityKey = localIdentity?.identity_key
    ?? `${normalizeTitle(row.filename)}:${titleYear(row.filename) ?? ""}`;
  const quality = qualityOf(row, indexes);
  const sameIdentity = (indexes.identity.get(identityKey) ?? []).filter((candidate) => candidate.id !== row.id);
  const exactDuplicate = row.checksum
    ? (indexes.checksum.get(row.checksum) ?? []).find((candidate) => candidate.id !== row.id)
    : undefined;
  const fingerprintDuplicate = row.fingerprint
    ? (indexes.fingerprint.get(row.fingerprint) ?? []).find((candidate) => candidate.id !== row.id)
    : undefined;
  const match = plexMatch(row, plexTitleIndex, episodeIndex, localIdentity);
  let qualityStatus: QualityStatus = row.scan_status === "missing"
    ? "file_missing"
    : row.scan_status === "error"
      ? "needs_review"
      : "local_only";
  let qualitySummary = row.scan_status === "missing"
    ? "The file was not present during the latest completed scan."
    : row.scan_status === "error"
      ? "FFprobe could not provide reliable metadata for this file."
      : "No matching Plex item was found.";
  let qualityDifferences: string[] = [];
  if (row.scan_status === "active" && (exactDuplicate || fingerprintDuplicate)) {
    qualityStatus = "duplicate";
    qualitySummary = exactDuplicate ? "Exact SHA-256 checksum matches another local file." : "Normalized title, duration, dimensions, and codecs match another local file.";
  } else if (row.scan_status === "active" && sameIdentity.length) {
    const group = indexes.groups.get(identityKey);
    if (group?.ambiguous) {
      // No encode dominates the others: a resolution gain traded against a
      // better dynamic range or a different codec generation is an operator
      // decision, so the inventory refuses to crown a "best" copy.
      qualityStatus = "needs_review";
      qualityDifferences = group.differences;
      qualitySummary = "Local versions of this identity differ in ways the stored metadata cannot rank; no best copy was selected.";
    } else {
      const best = group ? indexes.rowsById.get(group.championId) ?? row : row;
      if (best.id === row.id) {
        qualityStatus = "best_local_version";
        qualitySummary = group
          ? "At least as good as every other local version of this identity on all comparable measured axes."
          : "Only local version of this normalized media identity.";
      } else {
        qualityStatus = "lower_quality_version";
        qualityDifferences = legacyQualityDifferences(quality, qualityOf(best, indexes));
        qualitySummary = "Another local version is at least as good on every comparable measured axis; factors are listed below.";
      }
    }
  } else if (row.scan_status === "active" && match) {
    const plexQuality = plexQualityShape(match, indexes);
    const differences = legacyQualityDifferences(quality, plexQuality);
    const localRank = coarseQualityScore(quality);
    const plexRank = coarseQualityScore(plexQuality);
    const localHasHdr = hasHdr(quality);
    const plexHasHdr = hasHdr(plexQuality);
    const resolutionDiffers =
      quality.height !== null &&
      plexQuality.height !== null &&
      quality.height !== plexQuality.height;
    const localHasHigherResolution =
      resolutionDiffers && quality.height! > plexQuality.height!;
    const materialTradeoff =
      resolutionDiffers &&
      (localHasHigherResolution ? plexHasHdr && !localHasHdr : localHasHdr && !plexHasHdr);
    qualityDifferences = differences;
    if (!differences.length) {
      qualityStatus = "plex_version_exists";
      qualitySummary = "A matching Plex item exists with equivalent available quality metadata.";
    } else if (materialTradeoff) {
      qualityStatus = "needs_review";
      qualitySummary = "The local and Plex versions make a material resolution-versus-HDR tradeoff.";
    } else if (localRank > plexRank) {
      qualityStatus = "higher_quality_available";
      qualitySummary = "The local file ranks higher than the matched Plex version on available metadata.";
    } else {
      qualityStatus = "lower_quality_version";
      qualitySummary = "The matched Plex version ranks higher on available metadata.";
    }
  }
  const duplicateOfId = exactDuplicate?.id ?? fingerprintDuplicate?.id ?? null;
  const duplicateKind = exactDuplicate ? "exact" : fingerprintDuplicate ? "probable" : null;
  const plexMatchResult = match ? {
    ratingKey: match.rating_key,
    title: match.title,
    year: match.year,
    qualityDifferences,
  } : null;
  const evidenceKey = reviewEvidenceKey({
    qualityStatus,
    checksum: row.checksum,
    fingerprint: row.fingerprint,
    duplicateOfId,
    qualityDifferences,
    plexMatch: plexMatchResult,
  });
  const review = readReview(ownerId, row.id, qualityStatus, evidenceKey, reviews);
  return {
    id: row.id,
    archiveItemId: row.archive_item_id,
    filename: row.filename,
    path: row.path,
    relativePath: row.relative_path,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    checksumStatus: row.checksum_status ?? (row.checksum ? "computed" : "not_computed"),
    mediaType: row.media_type,
    scanStatus: row.scan_status,
    errorMessage: row.error_message,
    durationSeconds: row.duration_seconds,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    width: row.width,
    height: row.height,
    fps: row.fps,
    bitrate: row.bitrate,
    container: row.container,
    dynamicRange: row.dynamic_range,
    dynamicRangeFormat: quality.dynamicRange,
    audioChannels: row.audio_channels,
    audioLanguages: parseJsonArray(row.audio_languages),
    subtitleLanguages: parseJsonArray(row.subtitle_languages),
    lastSeenAt: row.last_seen_at,
    qualityStatus,
    qualitySummary,
    qualityDifferences,
    duplicateOfId,
    duplicateKind,
    identityKey,
    plexMatch: plexMatchResult,
    reviewStatus: review.status,
    reviewNote: review.note,
    reviewUpdatedAt: review.updatedAt,
    reviewEvidenceKey: evidenceKey,
  };
}

/** True when the normalized model reports a non-SDR, non-unknown dynamic range. */
function hasHdr(quality: QualityShape) {
  return quality.dynamicRange !== "sdr" && quality.dynamicRange !== "unknown";
}

export type IdentityGroup = {
  championId: number;
  /** True when no member dominates the others, so "best" is not defensible. */
  ambiguous: boolean;
  memberIds: number[];
  differences: string[];
};

export type InventoryIndexes = {
  identity: Map<string, FileRow[]>;
  checksum: Map<string, FileRow[]>;
  fingerprint: Map<string, FileRow[]>;
  rowsById: Map<number, FileRow>;
  quality: Map<number, QualityShape>;
  plexQuality: Map<number, QualityShape>;
  groups: Map<string, IdentityGroup>;
};

/**
 * Picks the representative encode for one semantic identity.
 *
 * A member wins only when nothing else in the group dominates it, where
 * dominance comes from `compareEncodes` (at least as good on every comparable
 * measured axis and strictly better on at least one). When several members
 * survive, the group is ambiguous and the caller must not present a winner.
 */
function selectIdentityChampion(rows: FileRow[], modelOf: (row: FileRow) => QualityShape): IdentityGroup | null {
  let members = rows;
  if (members.length < 2) return null;
  // Byte-identical copies are one candidate, not competing versions: keep the
  // lowest record id per checksum so duplicate sets cannot make a group look
  // ambiguous, and so the surviving members are genuinely distinct encodes.
  const perChecksum = new Map<string, FileRow>();
  for (const member of members) {
    if (!member.checksum) continue;
    const known = perChecksum.get(member.checksum);
    if (!known || member.id < known.id) perChecksum.set(member.checksum, member);
  }
  if (perChecksum.size) {
    const seenChecksums = new Set(perChecksum.keys());
    const deduped = members.filter(
      (member) => !member.checksum || (seenChecksums.has(member.checksum) && perChecksum.get(member.checksum)!.id === member.id),
    );
    if (deduped.length !== members.length) members = deduped;
  }
  if (members.length < 2) return null;
  const dominated = new Set<number>();
  for (const [index, left] of members.entries()) {
    for (const right of members.slice(index + 1)) {
      const comparison = compareEncodes(modelOf(left), modelOf(right));
      if (comparison.relationship === "superior_encode" && comparison.winner === "left") {
        dominated.add(right.id);
      } else if (comparison.relationship === "inferior_encode" && comparison.winner === "right") {
        dominated.add(left.id);
      } else if (comparison.relationship === "exact_duplicate") {
        // Byte-identical copies are redundant, not competing versions; keep
        // the lower record id as the canonical one so the choice is stable.
        dominated.add(Math.max(left.id, right.id));
      }
    }
  }
  const front = members.filter((member) => !dominated.has(member.id));
  if (!front.length) return null;
  if (front.length === 1) {
    // A single survivor needs no difference list: each losing record already
    // gets its own comparison against the champion in `mapFile`.
    return {
      championId: front[0].id,
      ambiguous: false,
      memberIds: members.map((member) => member.id),
      differences: [],
    };
  }
  const champion = front.reduce((best, candidate) =>
    coarseQualityScore(modelOf(candidate)) > coarseQualityScore(modelOf(best)) ? candidate : best,
  );
  const differences = Array.from(new Set(
    front
      .filter((member) => member.id !== champion.id)
      .flatMap((member) => legacyQualityDifferences(modelOf(champion), modelOf(member))),
  ));
  return { championId: champion.id, ambiguous: true, memberIds: members.map((member) => member.id), differences };
}

function buildArchiveInventory(ownerId: string) {
  const rows = archiveDb.prepare(
    `SELECT file_record.id, file_record.archive_item_id, file_record.local_identity_id, file_record.filename,
            file_record.path, file_record.relative_path, file_record.size_bytes, file_record.checksum,
            file_record.checksum_status, file_record.media_type, file_record.scan_status, file_record.error_message,
            file_record.duration_seconds, file_record.video_codec, file_record.audio_codec, file_record.width,
            file_record.height, file_record.fps, file_record.bitrate, file_record.container, file_record.dynamic_range,
            file_record.audio_channels, file_record.audio_languages, file_record.subtitle_languages,
            file_record.fingerprint, file_record.video_profile, file_record.video_pix_fmt, file_record.video_bit_depth,
            file_record.color_primaries, file_record.audio_profile, file_record.audio_channel_layout,
            file_record.video_bitrate, file_record.audio_bitrate, file_record.audio_tracks, file_record.subtitle_tracks,
            file_record.modified_at_ms, file_record.last_seen_at, file_record.volume_id, file_record.archive_root,
            local_media_identity.identity_key AS identity_key
     FROM file_record
     LEFT JOIN local_media_identity ON local_media_identity.id = file_record.local_identity_id
     WHERE file_record.owner_id = ?
     ORDER BY file_record.filename COLLATE NOCASE, file_record.path`,
    ).all(ownerId) as FileRow[];
  const identityRows = archiveDb.prepare(
    `SELECT id, identity_key, media_type, normalized_title, year, show_identity,
            season_number, episode_number, size_bytes, fingerprint, checksum
     FROM local_media_identity
     WHERE owner_id = ?`,
  ).all(ownerId) as LocalMediaIdentity[];
  const identities = new Map(identityRows.map((identity) => [identity.id, identity]));
  const plexRows = readPlexRows(ownerId);
  const episodeIndex = plexEpisodeIndex(plexRows);
  const plexTitleIndex = plexTitleIndexes(plexRows);
  const indexes: InventoryIndexes = {
    identity: new Map(),
    checksum: new Map(),
    fingerprint: new Map(),
    rowsById: new Map(),
    quality: new Map(),
    plexQuality: new Map(),
    groups: new Map(),
  };
  for (const row of rows) {
    indexes.quality.set(row.id, technicalQualityFromRecord(row));
    indexes.rowsById.set(row.id, row);
    if (row.scan_status !== "active") continue;
    const localIdentity = row.local_identity_id === null || row.local_identity_id === undefined
      ? undefined
      : identities.get(row.local_identity_id);
    const identityKey = localIdentity?.identity_key
      ?? `${normalizeTitle(row.filename)}:${titleYear(row.filename) ?? ""}`;
    const identityRows = indexes.identity.get(identityKey) ?? [];
    identityRows.push(row);
    indexes.identity.set(identityKey, identityRows);
    if (row.checksum) {
      const checksumRows = indexes.checksum.get(row.checksum) ?? [];
      checksumRows.push(row);
      indexes.checksum.set(row.checksum, checksumRows);
    }
    if (row.fingerprint) {
      const fingerprintRows = indexes.fingerprint.get(row.fingerprint) ?? [];
      fingerprintRows.push(row);
      indexes.fingerprint.set(row.fingerprint, fingerprintRows);
    }
  }
  for (const plexRow of plexRows) {
    indexes.plexQuality.set(plexRow.id, plexQualityShape(plexRow, indexes));
  }
  for (const [identityKey, members] of indexes.identity) {
    const group = selectIdentityChampion(members, (row) => indexes.quality.get(row.id) ?? technicalQualityFromRecord(row));
    if (group) indexes.groups.set(identityKey, group);
  }
  const reviews = new Map<string, ReviewRow>();
  const reviewRows = archiveDb.prepare(
    "SELECT owner_id, file_record_id, finding_type, evidence_key, status, note, updated_at FROM archive_review WHERE owner_id = ?",
  ).all(ownerId) as Array<ReviewRow & {
    owner_id: string;
    file_record_id: number;
    finding_type: QualityStatus;
    evidence_key: string;
  }>;
  for (const review of reviewRows) {
    reviews.set(`${review.owner_id}:${review.file_record_id}:${review.finding_type}:${review.evidence_key}`, review);
  }
  const records = rows.map((row) => mapFile(
    ownerId,
    row,
    indexes,
    plexRows,
    episodeIndex,
    plexTitleIndex,
    reviews,
    row.local_identity_id === null || row.local_identity_id === undefined
      ? undefined
      : identities.get(row.local_identity_id),
  ));
  const matchedPlexKeys = new Set(records.map((record) => record.plexMatch?.ratingKey).filter((key): key is string => Boolean(key)));
  const plexOnly = plexRows
    .filter((plex) => !matchedPlexKeys.has(plex.rating_key))
    .map((plex) => ({
      ratingKey: plex.rating_key,
      title: plex.title,
      itemType: plex.item_type,
      year: plex.year,
      qualitySummary: "Plex contains this item, but no matching local file was found.",
    }));
  const scan = readArchiveScan(ownerId);
  return {
    scan,
    summary: {
      activeFiles: records.filter((record) => record.scanStatus === "active").length,
      failedFiles: records.filter((record) => record.scanStatus === "error").length,
      duplicateCount: records.filter((record) => record.qualityStatus === "duplicate").length,
      missingCount: records.filter((record) => record.qualityStatus === "file_missing").length,
      qualityConflictCount: records.filter((record) => ["lower_quality_version", "higher_quality_available"].includes(record.qualityStatus)).length,
      plexOnlyCount: plexOnly.length,
      localOnlyCount: records.filter((record) => record.qualityStatus === "local_only").length,
      reviewedCount: records.filter((record) => record.reviewStatus === "reviewed").length,
      unresolvedCount: records.filter((record) => ["unreviewed", "unresolved"].includes(record.reviewStatus)).length,
    },
    records,
    plexOnly,
    // Internal, non-serialized context: the normalized quality model, the
    // identity groups, and the Plex rows that produced these records. The
    // quality findings layer reads it so the same scan output backs both
    // views instead of a second inspection pass.
    context: {
      indexes,
      identities,
      plexRows,
      episodeIndex,
      plexTitleIndex,
    },
  };
}

export type ArchiveInventoryRecord = ReturnType<typeof mapFile>;
export type ArchiveInventoryContext = ReturnType<typeof buildArchiveInventory>;

export function invalidateArchiveInventoryCache(ownerId: string) {
  inventoryCache.delete(ownerId);
}

export function readArchiveInventory(ownerId: string) {
  const cached = inventoryCache.get(ownerId);
  if (cached) return cached;
  const inventory = buildArchiveInventory(ownerId);
  inventoryCache.set(ownerId, inventory);
  return inventory;
}

export function readArchiveRecord(ownerId: string, id: number) {
  const inventory = readArchiveInventory(ownerId);
  return inventory.records.find((record) => record.id === id) ?? null;
}

function persistArchiveRecordReview(
  ownerId: string,
  record: ReturnType<typeof mapFile>,
  status: SavedReviewStatus,
  note: string | null,
) {
  if (!reviewableQualityStatuses.has(record.qualityStatus)) {
    throw new Error("This archive record has no active duplicate or quality finding to review.");
  }
  const evidenceKey = record.reviewEvidenceKey;
  archiveDb.prepare(
    `INSERT INTO archive_review
      (owner_id, file_record_id, finding_type, evidence_key, status, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(owner_id, file_record_id, finding_type, evidence_key) DO UPDATE SET
       status = excluded.status, note = excluded.note, updated_at = CURRENT_TIMESTAMP`,
  ).run(ownerId, record.id, record.qualityStatus, evidenceKey, status, note);
  const saved = archiveDb.prepare(
    `SELECT status, finding_type, note, updated_at
     FROM archive_review
     WHERE owner_id = ? AND file_record_id = ? AND finding_type = ? AND evidence_key = ?`,
  ).get(ownerId, record.id, record.qualityStatus, evidenceKey) as {
    status: SavedReviewStatus;
    finding_type: string;
    note: string | null;
    updated_at: string;
  };
  const result = {
    status: saved.status,
    findingType: saved.finding_type,
    note: saved.note,
    reviewedAt: saved.updated_at,
    updatedAt: saved.updated_at,
  };
  invalidateArchiveInventoryCache(ownerId);
  return result;
}

export function updateArchiveRecordReview(ownerId: string, id: number, status: SavedReviewStatus, note: string | null) {
  const record = readArchiveRecord(ownerId, id);
  if (!record) return null;
  return persistArchiveRecordReview(ownerId, record, status, note);
}

export function updateArchiveRecordReviews(
  ownerId: string,
  ids: number[],
  status: SavedReviewStatus,
  note: string | null,
) {
  const records = new Map(readArchiveInventory(ownerId).records.map((record) => [record.id, record]));
  const results = ids.map((id) => {
    const record = records.get(id);
    if (!record) {
      return { id, success: false, review: null, error: "Archive record not found." };
    }
    try {
      return {
        id,
        success: true,
        review: persistArchiveRecordReview(ownerId, record, status, note),
        error: null,
      };
    } catch (error) {
      return {
        id,
        success: false,
        review: null,
        error: error instanceof Error ? error.message : "Review decision could not be saved.",
      };
    }
  });
  const succeeded = results.filter((result) => result.success).length;
  return {
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}