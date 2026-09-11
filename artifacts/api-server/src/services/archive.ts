import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { archiveDb, addEvent, readSettings, type SettingsRecord } from "../lib/archive-db";
import { inspectLocalMedia } from "./media";
import {
  assessMediaIntegrityFailure,
  mediaIntegritySummary,
  type MediaIntegrityClassification,
} from "./media-integrity";
import { getArchiveScanRoots } from "./storage";

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
  integrity_classification: MediaIntegrityClassification | null;
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

type QualityShape = {
  height: number | null;
  hdr: boolean;
  videoCodec: string | null;
  bitrate: number | null;
  audioCodec: string | null;
  audioChannels: number | null;
  container: string | null;
};

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

function archiveVolumeId(root: string) {
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

function qualityShape(row: Pick<FileRow, "height" | "dynamic_range" | "video_codec" | "bitrate" | "audio_codec" | "audio_channels" | "container">): QualityShape {
  return {
    height: row.height,
    hdr: Boolean(row.dynamic_range && /hdr|smpte2084|arib-std-b67|hlg/i.test(row.dynamic_range)),
    videoCodec: row.video_codec,
    bitrate: row.bitrate,
    audioCodec: row.audio_codec,
    audioChannels: row.audio_channels,
    container: row.container,
  };
}

function plexQualityShape(row: PlexRow): QualityShape {
  const metadata = parseMetadata(row.metadata_json);
  const media = asRecord(metadata.media);
  return {
    height: row.video_resolution ? Number.parseInt(row.video_resolution.replace(/\D/g, ""), 10) || null : null,
    hdr: Boolean(metadata.dynamicRange && /hdr|smpte2084|arib-std-b67|hlg/i.test(String(metadata.dynamicRange))),
    videoCodec: row.video_codec,
    bitrate: row.bitrate,
    audioCodec: row.audio_codec,
    audioChannels: typeof media?.audioChannels === "number" ? media.audioChannels : null,
    container: typeof media?.container === "string" ? media.container : null,
  };
}

export function qualityRank(shape: QualityShape) {
  const height = shape.height ?? 0;
  const hdr = shape.hdr ? 5000 : 0;
  const codec = /av1/i.test(shape.videoCodec ?? "") ? 300 : /265|hevc/i.test(shape.videoCodec ?? "") ? 250 : /264/i.test(shape.videoCodec ?? "") ? 150 : 50;
  const bitrate = Math.min(100, Math.round((shape.bitrate ?? 0) / 1_000_000));
  const audio = shape.audioChannels ?? 0;
  return height + hdr + codec + bitrate + audio;
}

function qualityDifferences(left: QualityShape, right: QualityShape) {
  const differences: string[] = [];
  if (left.height !== right.height && (left.height !== null || right.height !== null)) differences.push(`resolution ${left.height ?? "unknown"}p vs ${right.height ?? "unknown"}p`);
  if (left.hdr !== right.hdr) differences.push(`${left.hdr ? "HDR" : "SDR"} vs ${right.hdr ? "HDR" : "SDR"}`);
  if (left.videoCodec !== right.videoCodec) differences.push(`video codec ${left.videoCodec ?? "unknown"} vs ${right.videoCodec ?? "unknown"}`);
  if (left.bitrate !== right.bitrate && (left.bitrate !== null || right.bitrate !== null)) differences.push(`bitrate ${left.bitrate ?? "unknown"} vs ${right.bitrate ?? "unknown"}`);
  if (left.audioCodec !== right.audioCodec) differences.push(`audio codec ${left.audioCodec ?? "unknown"} vs ${right.audioCodec ?? "unknown"}`);
  if (left.audioChannels !== right.audioChannels && (left.audioChannels !== null || right.audioChannels !== null)) differences.push(`audio channels ${left.audioChannels ?? "unknown"} vs ${right.audioChannels ?? "unknown"}`);
  if (left.container !== right.container) differences.push(`container ${left.container ?? "unknown"} vs ${right.container ?? "unknown"}`);
  return differences;
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

function scanRoots(settings: SettingsRecord) {
  return getArchiveScanRoots(settings);
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

function upsertArchiveRecord(
  ownerId: string,
  filePath: string,
  root: string,
  modifiedAtMs: number,
  inspected: Awaited<ReturnType<typeof inspectLocalMedia>> | null,
  fileChecksum: string | null,
  errorMessage: string | null,
  integrityClassification: MediaIntegrityClassification | null,
) {
  const filename = basename(filePath);
  const relativePath = relative(root, filePath);
  const title = filename.replace(/\.[^.]+$/, "");
  const fingerprint = inspected
    ? [
      normalizeTitle(filename),
      inspected.durationSeconds === null ? "unknown" : Math.round(inspected.durationSeconds),
      inspected.width ?? "unknown",
      inspected.height ?? "unknown",
      inspected.videoCodec ?? "unknown",
      inspected.audioCodec ?? "unknown",
    ].join("|")
    : null;
  const localIdentity = localIdentityFor(filename, root, inspected?.filesize ?? null, fingerprint, fileChecksum);
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
  const localIdentityId = Number((archiveDb.prepare(
    "SELECT id FROM local_media_identity WHERE owner_id = ? AND identity_key = ?",
  ).get(ownerId, localIdentity.identityKey) as { id: number }).id);

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
          subtitle_languages, fingerprint, error_message, integrity_classification, updated_at)
       VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?,
         ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
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
          error_message = excluded.error_message, integrity_classification = excluded.integrity_classification,
          updated_at = CURRENT_TIMESTAMP`,
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
    integrityClassification,
  );
}

async function inspectFile(filePath: string, root: string, existing: FileRow | undefined, settings: SettingsRecord, archiveScanRoots: string[]) {
  const fileStats = await stat(filePath);
  const unchanged = existing
    && existing.scan_status === "active"
    && existing.size_bytes === fileStats.size
    && existing.modified_at_ms === Math.trunc(fileStats.mtimeMs);
  if (unchanged) {
    return {
      filePath,
      root,
      modifiedAtMs: Math.trunc(fileStats.mtimeMs),
      inspected: null,
      fileChecksum: null,
      errorMessage: null,
      integrityClassification: null,
      unchangedRecordId: existing.id,
      warningMessage: undefined,
    };
  }

  let inspected: Awaited<ReturnType<typeof inspectLocalMedia>> | null = null;
  let fileChecksum: string | null = null;
  let errorMessage: string | null = null;
  let integrityClassification: MediaIntegrityClassification | null = null;
  try {
    inspected = await inspectLocalMedia(filePath, settings, archiveScanRoots);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "The file could not be inspected.";
    integrityClassification = assessMediaIntegrityFailure(errorMessage).classification;
  }
  if (inspected) {
    try {
      fileChecksum = await checksum(filePath);
    } catch (error) {
      inspected = null;
      errorMessage = error instanceof Error ? error.message : "The file could not be checksummed.";
      integrityClassification = assessMediaIntegrityFailure(errorMessage, "operational").classification;
    }
  }
  return {
    filePath,
    root,
    modifiedAtMs: Math.trunc(fileStats.mtimeMs),
    inspected,
    fileChecksum,
    errorMessage,
    integrityClassification,
    unchangedRecordId: null,
    warningMessage: undefined,
  };
}

async function scanArchive(ownerId: string) {
  invalidateArchiveInventoryCache(ownerId);
  const settings = readSettings();
  const roots = scanRoots(settings);
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

for (const root of roots) {
  try {
    await access(root);

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
                errorMessage: null,
                integrityClassification: "inspection_unavailable" as const,
                unchangedRecordId: null,
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
                archiveDb.prepare(
                  "UPDATE file_record SET last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?",
                ).run(result.unchangedRecordId, ownerId);
              } else {
                upsertArchiveRecord(
                  ownerId,
                  result.filePath,
                  result.root,
                  result.modifiedAtMs,
                  result.inspected,
                  result.fileChecksum,
                  result.errorMessage,
                  result.integrityClassification,
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

function integrityClassificationFor(row: Pick<FileRow, "integrity_classification" | "error_message">) {
  if (
    row.integrity_classification === "corrupt_or_malformed_container"
    || row.integrity_classification === "inspection_unavailable"
  ) {
    return row.integrity_classification;
  }
  return row.error_message ? assessMediaIntegrityFailure(row.error_message).classification : null;
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
  const integrityClassification = integrityClassificationFor(row);
  const integritySummary = mediaIntegritySummary(integrityClassification);
  const identityKey = localIdentity?.identity_key
    ?? `${normalizeTitle(row.filename)}:${titleYear(row.filename) ?? ""}`;
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
      ? integritySummary ?? "FFprobe could not provide reliable metadata for this file."
      : "No matching Plex item was found.";
  let qualityDifferences: string[] = [];
  if (row.scan_status === "active" && (exactDuplicate || fingerprintDuplicate)) {
    qualityStatus = "duplicate";
    qualitySummary = exactDuplicate ? "Exact SHA-256 checksum matches another local file." : "Normalized title, duration, dimensions, and codecs match another local file.";
  } else if (row.scan_status === "active" && sameIdentity.length) {
    const best = indexes.bestByIdentity.get(identityKey) ?? row;
    if (best.id === row.id) {
      qualityStatus = "best_local_version";
      qualitySummary = "Highest available local version for this normalized media identity.";
    } else {
      qualityStatus = "lower_quality_version";
      qualityDifferences = qualityDifferencesFor(row, best);
      qualitySummary = "A higher-quality local version exists; factors are listed below.";
    }
  } else if (row.scan_status === "active" && match) {
    const differences = qualityDifferencesFor(row, match);
    const localQuality = qualityShape(row);
    const plexQuality = plexQualityShape(match);
    const localRank = qualityRank(localQuality);
    const plexRank = qualityRank(plexQuality);
    const resolutionDiffers =
      localQuality.height !== null &&
      plexQuality.height !== null &&
      localQuality.height !== plexQuality.height;
    const localHasHigherResolution =
      resolutionDiffers && localQuality.height! > plexQuality.height!;
    const localHasHdr = localQuality.hdr && !plexQuality.hdr;
    const plexHasHdr = plexQuality.hdr && !localQuality.hdr;
    const materialTradeoff =
      resolutionDiffers &&
      (localHasHigherResolution ? plexHasHdr : localHasHdr);
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
    mediaType: row.media_type,
    scanStatus: row.scan_status,
    errorMessage: row.error_message,
    integrityClassification,
    integritySummary,
    durationSeconds: row.duration_seconds,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    width: row.width,
    height: row.height,
    fps: row.fps,
    bitrate: row.bitrate,
    container: row.container,
    dynamicRange: row.dynamic_range,
    audioChannels: row.audio_channels,
    audioLanguages: parseJsonArray(row.audio_languages),
    subtitleLanguages: parseJsonArray(row.subtitle_languages),
    lastSeenAt: row.last_seen_at,
    qualityStatus,
    qualitySummary,
    qualityDifferences,
    duplicateOfId,
    plexMatch: plexMatchResult,
    reviewStatus: review.status,
    reviewNote: review.note,
    reviewUpdatedAt: review.updatedAt,
    reviewEvidenceKey: evidenceKey,
  };
}

function qualityDifferencesFor(local: FileRow, other: FileRow | PlexRow) {
  return qualityDifferences(
    qualityShape(local),
    "rating_key" in other ? plexQualityShape(other) : qualityShape(other),
  );
}

type InventoryIndexes = {
  identity: Map<string, FileRow[]>;
  checksum: Map<string, FileRow[]>;
  fingerprint: Map<string, FileRow[]>;
  bestByIdentity: Map<string, FileRow>;
};

function buildArchiveInventory(ownerId: string) {
  const rows = archiveDb.prepare(
    "SELECT id, archive_item_id, local_identity_id, filename, path, relative_path, size_bytes, checksum, media_type, scan_status, error_message, integrity_classification, duration_seconds, video_codec, audio_codec, width, height, fps, bitrate, container, dynamic_range, audio_channels, audio_languages, subtitle_languages, fingerprint, modified_at_ms, last_seen_at FROM file_record WHERE owner_id = ? ORDER BY filename COLLATE NOCASE, path",
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
    bestByIdentity: new Map(),
  };
  for (const row of rows) {
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
    const best = indexes.bestByIdentity.get(identityKey);
    if (!best || qualityRank(qualityShape(row)) > qualityRank(qualityShape(best))) {
      indexes.bestByIdentity.set(identityKey, row);
    }
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
  const integrityFailureCount = records.filter(
    (record) => record.integrityClassification === "corrupt_or_malformed_container",
  ).length;
  const inspectionFailureCount = records.filter(
    (record) => record.scanStatus === "error" && record.integrityClassification === "inspection_unavailable",
  ).length;
  return {
    scan,
    summary: {
      activeFiles: records.filter((record) => record.scanStatus === "active").length,
      failedFiles: records.filter((record) => record.scanStatus === "error").length,
      integrityFailureCount,
      inspectionFailureCount,
      healthStatus: integrityFailureCount || inspectionFailureCount ? "attention_required" : "healthy",
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
  };
}

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