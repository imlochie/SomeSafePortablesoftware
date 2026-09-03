import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { archiveDb, addEvent, readSettings } from "../lib/archive-db";
import { inspectLocalMedia } from "./media";

const supportedExtensions = new Set([
  ".avi", ".flac", ".m4a", ".m4v", ".mkv", ".mov", ".mp3", ".mp4",
  ".mpeg", ".mpg", ".ogg", ".ogv", ".ts", ".wav", ".webm", ".wmv",
]);
const scans = new Map<string, Promise<void>>();

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

function normalizeTitle(value: string) {
  return value
    .replace(/\.[^.]+$/, "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/\b(4k|uhd|2160p?|1080p?|720p?|480p?|bluray|web[ ._-]?dl|x26[45]|h26[45]|hevc|av1)\b/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleYear(value: string) {
  const match = value.match(/\b((?:19|20)\d{2})\b/);
  return match ? Number(match[1]) : null;
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

function qualityRank(shape: QualityShape) {
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

async function* walk(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase())) {
      yield path;
    }
  }
}

function scanRoots() {
  const settings = readSettings();
  return Array.from(new Set([settings.archiveDirectory, settings.downloadDirectory].map(expandPath)));
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

function upsertArchiveRecord(ownerId: string, filePath: string, root: string, modifiedAtMs: number, inspected: Awaited<ReturnType<typeof inspectLocalMedia>> | null, fileChecksum: string | null, errorMessage: string | null) {
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

  archiveDb.exec("BEGIN IMMEDIATE");
  try {
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
         scan_status, last_seen_at, modified_at_ms, extension, duration_seconds, video_codec, audio_codec,
         width, height, fps, bitrate, container, dynamic_range, audio_channels, audio_languages,
         subtitle_languages, fingerprint, error_message, updated_at)
       VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?,
         ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
       )
       ON CONFLICT(owner_id, path) DO UPDATE SET
         size_bytes = excluded.size_bytes, checksum = excluded.checksum, media_type = excluded.media_type,
         archive_item_id = excluded.archive_item_id, filename = excluded.filename, relative_path = excluded.relative_path,
         scan_status = excluded.scan_status, last_seen_at = excluded.last_seen_at, modified_at_ms = excluded.modified_at_ms,
         extension = excluded.extension, duration_seconds = excluded.duration_seconds, video_codec = excluded.video_codec,
         audio_codec = excluded.audio_codec, width = excluded.width, height = excluded.height, fps = excluded.fps,
         bitrate = excluded.bitrate, container = excluded.container, dynamic_range = excluded.dynamic_range,
         audio_channels = excluded.audio_channels, audio_languages = excluded.audio_languages,
         subtitle_languages = excluded.subtitle_languages, fingerprint = excluded.fingerprint,
         error_message = excluded.error_message, updated_at = CURRENT_TIMESTAMP`,
    ).run(
      filePath,
      inspected?.filesize ?? null,
      fileChecksum,
      inspected?.container ?? null,
      ownerId,
      archiveItemId,
      filename,
      relativePath,
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
    );
    archiveDb.exec("COMMIT");
  } catch (error) {
    archiveDb.exec("ROLLBACK");
    throw error;
  }
}

async function inspectFile(ownerId: string, filePath: string, root: string) {
  const settings = readSettings();
  const fileStats = await stat(filePath);
  const existing = archiveDb.prepare(
    "SELECT * FROM file_record WHERE owner_id = ? AND path = ?",
  ).get(ownerId, filePath) as FileRow | undefined;
  const unchanged = existing
    && existing.scan_status === "active"
    && existing.size_bytes === fileStats.size
    && existing.modified_at_ms === Math.trunc(fileStats.mtimeMs);
  if (unchanged) {
    archiveDb.prepare(
      "UPDATE file_record SET last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?",
    ).run(existing.id, ownerId);
    return true;
  }

  let inspected: Awaited<ReturnType<typeof inspectLocalMedia>> | null = null;
  let fileChecksum: string | null = null;
  let errorMessage: string | null = null;
  try {
    inspected = await inspectLocalMedia(filePath, settings);
    fileChecksum = await checksum(filePath);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "The file could not be inspected.";
  }
  upsertArchiveRecord(ownerId, filePath, root, Math.trunc(fileStats.mtimeMs), inspected, fileChecksum, errorMessage);
  return inspected !== null;
}

async function scanArchive(ownerId: string) {
  const roots = scanRoots();
  const found = new Set<string>();
  let scannedFiles = 0;
  let failedFiles = 0;
  let rootError: string | null = null;
  updateScan(ownerId, {
    status: "scanning",
    started_at: new Date().toISOString(),
    completed_at: null,
    last_error: null,
    scanned_files: 0,
    failed_files: 0,
  });

  for (const root of roots) {
    try {
      await access(root);
      for await (const filePath of walk(root)) {
        found.add(filePath);
        scannedFiles += 1;
        try {
          const inspected = await inspectFile(ownerId, filePath, root);
          if (!inspected) failedFiles += 1;
        } catch (error) {
          failedFiles += 1;
          addEvent("warning", `Archive scan could not inspect ${basename(filePath)}: ${error instanceof Error ? error.message : "unknown error"}`, "archive", ownerId);
        }
        updateScan(ownerId, { scanned_files: scannedFiles, failed_files: failedFiles });
      }
    } catch (error) {
      rootError = `${root}: ${error instanceof Error ? error.message : "directory could not be read"}`;
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

function plexMatch(row: FileRow, plexRows: PlexRow[]) {
  const localTitle = normalizeTitle(row.filename);
  const localYear = titleYear(row.filename);
  return plexRows.find((plex) => normalizeTitle(plex.title) === localTitle
    && (localYear === null || plex.year === null || localYear === plex.year));
}

function mapFile(row: FileRow, rows: FileRow[], plexRows: PlexRow[]) {
  const sameIdentity = rows.filter((candidate) => candidate.id !== row.id
    && candidate.scan_status === "active"
    && normalizeTitle(candidate.filename) === normalizeTitle(row.filename)
    && titleYear(candidate.filename) === titleYear(row.filename));
  const exactDuplicate = row.checksum
    ? rows.find((candidate) => candidate.id !== row.id && candidate.scan_status === "active" && candidate.checksum === row.checksum)
    : undefined;
  const fingerprintDuplicate = row.fingerprint
    ? rows.find((candidate) => candidate.id !== row.id && candidate.scan_status === "active" && candidate.fingerprint === row.fingerprint)
    : undefined;
  const match = plexMatch(row, plexRows);
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
    const best = [row, ...sameIdentity].sort((left, right) => qualityRank(qualityShape(right)) - qualityRank(qualityShape(left)))[0];
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
    const localRank = qualityRank(qualityShape(row));
    const plexRank = qualityRank(plexQualityShape(match));
    qualityDifferences = differences;
    if (!differences.length) {
      qualityStatus = "plex_version_exists";
      qualitySummary = "A matching Plex item exists with equivalent available quality metadata.";
    } else if (localRank > plexRank) {
      qualityStatus = "higher_quality_available";
      qualitySummary = "The local file ranks higher than the matched Plex version on available metadata.";
    } else {
      qualityStatus = "lower_quality_version";
      qualitySummary = "The matched Plex version ranks higher on available metadata.";
    }
  }
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
    duplicateOfId: exactDuplicate?.id ?? fingerprintDuplicate?.id ?? null,
    plexMatch: match ? {
      ratingKey: match.rating_key,
      title: match.title,
      year: match.year,
      qualityDifferences,
    } : null,
  };
}

function qualityDifferencesFor(local: FileRow, other: FileRow | PlexRow) {
  return qualityDifferences(
    qualityShape(local),
    "rating_key" in other ? plexQualityShape(other) : qualityShape(other),
  );
}

export function readArchiveInventory(ownerId: string) {
  const rows = archiveDb.prepare(
    "SELECT id, archive_item_id, filename, path, relative_path, size_bytes, checksum, media_type, scan_status, error_message, duration_seconds, video_codec, audio_codec, width, height, fps, bitrate, container, dynamic_range, audio_channels, audio_languages, subtitle_languages, fingerprint, modified_at_ms, last_seen_at FROM file_record WHERE owner_id = ? ORDER BY filename COLLATE NOCASE, path",
  ).all(ownerId) as FileRow[];
  const plexRows = readPlexRows(ownerId);
  const records = rows.map((row) => mapFile(row, rows, plexRows));
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
    },
    records,
    plexOnly,
  };
}

export function readArchiveRecord(ownerId: string, id: number) {
  const inventory = readArchiveInventory(ownerId);
  return inventory.records.find((record) => record.id === id) ?? null;
}