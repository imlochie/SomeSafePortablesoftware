import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";

const EXPECTED_TARGET = resolve("C:\\Projects\\SomeSafePortablesoftware\\data\\archive-assistant.sqlite");
const EXPECTED_SOURCE = resolve("C:\\Projects\\SomeSafePortablesoftware\\artifacts\\api-server\\data\\archive-assistant.sqlite");
const EXPECTED = {
  plex_item: 35_890,
  plex_show: 737,
  plex_season: 2_142,
  plex_episode: 33_283,
  plex_media: 36_545,
  plex_part: 36_619,
  plex_library: 2,
  file_record: 37_721,
  active_files: 37_567,
  error_files: 154,
  archive_item: 37_721,
};
const OWNER_ID = "__local__";
const CANONICAL_VOLUMES = [
  ["d-movies", "D:\\Movies", "movie"],
  ["d-tv", "D:\\Tv Shows", "tv"],
  ["e-movies", "E:\\Movies", "movie"],
  ["e-tv", "E:\\Tv Shows", "tv"],
];
const IMPORTED_TABLES = ["archive_item", "file_record", "archive_scan", "archive_review"];
const EMPTY_ARCHIVE_TABLES = [
  "source_record",
  "download_job",
  "processing_job",
  "queue_item",
  "assistant_conversation",
  "assistant_message",
];

function fail(message) {
  throw new Error(`Migration refused: ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  for (const arg of argv) {
    if (arg === "--api-stopped") values.set("api-stopped", "true");
    else if (arg.startsWith("--") && arg.includes("=")) {
      const [key, ...rest] = arg.slice(2).split("=");
      values.set(key, rest.join("="));
    }
  }
  return values;
}

function requireExactPaths(args) {
  if (args.get("api-stopped") !== "true") fail("pass --api-stopped only after stopping the API");
  if (!args.has("target") || !args.has("source")) fail("exact --target and --source paths are required");
  const target = resolve(args.get("target"));
  const source = resolve(args.get("source"));
  if (target !== EXPECTED_TARGET) fail(`target must be exactly ${EXPECTED_TARGET}`);
  if (source !== EXPECTED_SOURCE) fail(`source must be exactly ${EXPECTED_SOURCE}`);
  if (target === source) fail("source and target must be different files");
  if (!existsSync(target) || !existsSync(source)) fail("both database files must exist");
  return { target, source };
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function backupDatabase(path, backupPath) {
  mkdirSync(dirname(backupPath), { recursive: true });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

function normalizeWindowsPath(value) {
  return win32.normalize(value.replaceAll("/", "\\")).replace(/[\\]+$/, "").toLowerCase();
}

function canonicalVolume(filePath) {
  const normalizedFile = normalizeWindowsPath(filePath);
  for (const [id, root, mediaType] of CANONICAL_VOLUMES) {
    const normalizedRoot = normalizeWindowsPath(root);
    if (normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}\\`)) {
      return {
        id,
        root,
        mediaType,
        relativePath: relative(root, filePath).replaceAll("/", "\\"),
      };
    }
  }
  return null;
}

function normalizeTitle(value) {
  return value
    .replace(/\.[^.]+$/, "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/\b(4k|uhd|2160p?|1080p?|720p?|480p?|bluray|web[ ._-]?dl|x26[45]|h26[45]|hevc|av1)\b/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleYear(value) {
  const match = value.match(/\b((?:19|20)\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function localEpisodeIdentity(filename) {
  const name = filename.replace(/\.[^.]+$/, "");
  const match = name.match(/^(.+?)[\s._-]+(?:S(\d{1,2})[\s._-]*E(\d{1,2})|(\d{1,2})x(\d{1,2}))(?:[\s._-]|$)/i);
  if (!match) return null;
  const show = normalizeTitle(match[1]);
  const season = Number(match[2] ?? match[4]);
  const episode = Number(match[3] ?? match[5]);
  return show && Number.isInteger(season) && Number.isInteger(episode)
    ? { show, season, episode }
    : null;
}

function resolveLocalIdentity(row, volume) {
  const filename = row.filename || basename(row.path);
  if (volume.mediaType === "tv") {
    const episode = localEpisodeIdentity(filename);
    if (!episode) {
      return {
        identity: null,
        reason: "tv_identity_unresolved",
        mediaType: "tv",
      };
    }
    return {
      identity: {
        identityKey: `tv:${episode.show}:${episode.season}:${episode.episode}`,
        mediaType: "tv",
        normalizedTitle: episode.show,
        year: null,
        showIdentity: episode.show,
        seasonNumber: episode.season,
        episodeNumber: episode.episode,
      },
      reason: null,
      mediaType: "tv",
    };
  }
  const normalizedTitle = normalizeTitle(filename);
  if (!normalizedTitle) {
    return {
      identity: null,
      reason: "movie_title_unresolved",
      mediaType: "movie",
    };
  }
  const year = titleYear(filename);
  return {
    identity: {
      identityKey: `movie:${normalizedTitle}:${year ?? ""}`,
      mediaType: "movie",
      normalizedTitle,
      year,
      showIdentity: null,
      seasonNumber: null,
      episodeNumber: null,
    },
    reason: null,
    mediaType: "movie",
  };
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function count(db, table, predicate = "") {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"${predicate ? ` WHERE ${predicate}` : ""}`).get().count);
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
}

function ensureTargetSchema(db) {
  for (const table of ["file_record", "archive_item", "archive_scan", "archive_review", "local_media_identity"]) {
    if (!tableExists(db, table)) fail(`target is missing required table ${table}`);
  }
  for (const [column, definition] of [
    ["local_identity_id", "INTEGER REFERENCES local_media_identity(id)"],
    ["volume_id", "TEXT"],
    ["archive_root", "TEXT"],
  ]) {
    if (!columns(db, "file_record").has(column)) {
      db.exec(`ALTER TABLE file_record ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS file_record_local_identity_idx ON file_record(local_identity_id);
    CREATE INDEX IF NOT EXISTS local_media_identity_owner_type_idx ON local_media_identity(owner_id, media_type);
  `);
}

function assertExpectedCounts(db) {
  for (const [table, expected] of Object.entries({
    plex_item: EXPECTED.plex_item,
    plex_show: EXPECTED.plex_show,
    plex_season: EXPECTED.plex_season,
    plex_episode: EXPECTED.plex_episode,
    plex_media: EXPECTED.plex_media,
    plex_part: EXPECTED.plex_part,
    plex_library: EXPECTED.plex_library,
  })) {
    if (count(db, table) !== expected) fail(`target ${table} count is not ${expected}`);
  }
  for (const table of ["file_record", "archive_item", "local_media_identity", "archive_scan", "archive_review"]) {
    if (count(db, table) !== 0) fail(`target ${table} is not empty`);
  }
}

function assertSourcePreflight(db) {
  if (count(db, "file_record") !== EXPECTED.file_record) fail("source file_record count mismatch");
  if (count(db, "file_record", "scan_status = 'active'") !== EXPECTED.active_files) fail("source active file count mismatch");
  if (count(db, "file_record", "scan_status = 'error'") !== EXPECTED.error_files) fail("source error file count mismatch");
  if (count(db, "archive_item") !== EXPECTED.archive_item) fail("source archive_item count mismatch");
  for (const table of ["archive_item", "file_record", "archive_scan", "archive_review"]) {
    if (count(db, table, `owner_id <> '${OWNER_ID}'`) !== 0) fail(`source ${table} contains a non-local owner`);
  }
  for (const table of EMPTY_ARCHIVE_TABLES) {
    if (tableExists(db, table) && count(db, table) !== 0) fail(`source ${table} is non-empty and is not classified for import`);
  }
}

function assertNoIdCollisions(target) {
  for (const [table, column] of [["archive_item", "id"], ["file_record", "id"]]) {
    const collision = target.prepare(`
      SELECT 1 FROM "${table}" t
      JOIN source_db."${table}" s ON s."${column}" = t."${column}"
      LIMIT 1
    `).get();
    if (collision) fail(`${table}.${column} collision detected`);
  }
}

function importRows(target, source) {
  const archiveItems = source.prepare("SELECT id, title, source_id, status, archive_path, owner_id, created_at, updated_at FROM archive_item ORDER BY id").all();
  const insertArchiveItem = target.prepare(`
    INSERT INTO archive_item (id, title, source_id, status, archive_path, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of archiveItems) insertArchiveItem.run(row.id, row.title, row.source_id, row.status, row.archive_path, row.owner_id, row.created_at, row.updated_at);

  const fileRows = source.prepare("SELECT * FROM file_record ORDER BY id").all();
  const fileColumns = columns(source, "file_record");
  const insertFile = target.prepare(`
    INSERT INTO file_record (
      id, path, size_bytes, checksum, media_type, discovered_at, owner_id, archive_item_id,
      filename, relative_path, scan_status, last_seen_at, modified_at_ms, extension,
      duration_seconds, video_codec, audio_codec, width, height, fps, bitrate, container,
      dynamic_range, audio_channels, audio_languages, subtitle_languages, fingerprint,
      error_message, local_identity_id, volume_id, archive_root, updated_at
    ) VALUES (${Array.from({ length: 32 }, () => "?").join(", ")})
  `);
  const identities = new Map();
  const identityRows = [];
  const unresolved = [];
  for (const row of fileRows) {
    const volume = canonicalVolume(row.path);
    if (!volume) fail(`file path is outside canonical archive roots: ${row.path}`);
    const resolution = resolveLocalIdentity(row, volume);
    if (!resolution.identity) {
      unresolved.push({
        fileRecordId: row.id,
        path: row.path,
        mediaType: resolution.mediaType,
        reason: resolution.reason,
      });
      continue;
    }
    if (!identities.has(resolution.identity.identityKey)) {
      identities.set(resolution.identity.identityKey, resolution.identity);
      identityRows.push(resolution.identity);
    }
  }
  const insertIdentity = target.prepare(`
    INSERT INTO local_media_identity
      (owner_id, identity_key, media_type, normalized_title, year, show_identity,
       season_number, episode_number, size_bytes, fingerprint, checksum, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  const identityIds = new Map();
  for (const identity of identityRows) {
    const result = insertIdentity.run(
      OWNER_ID, identity.identityKey, identity.mediaType, identity.normalizedTitle,
      identity.year, identity.showIdentity, identity.seasonNumber, identity.episodeNumber,
      null, null, null,
    );
    identityIds.set(identity.identityKey, Number(result.lastInsertRowid));
  }
  for (const row of fileRows) {
    const volume = canonicalVolume(row.path);
    const resolution = resolveLocalIdentity(row, volume);
    insertFile.run(
      row.id, row.path, row.size_bytes, row.checksum, row.media_type, row.discovered_at,
      OWNER_ID, row.archive_item_id, row.filename, row.relative_path, row.scan_status,
      row.last_seen_at, row.modified_at_ms, row.extension, row.duration_seconds,
      row.video_codec, row.audio_codec, row.width, row.height, row.fps, row.bitrate,
      row.container, row.dynamic_range, row.audio_channels, row.audio_languages,
      row.subtitle_languages, row.fingerprint, row.error_message,
      resolution.identity ? identityIds.get(resolution.identity.identityKey) : null,
      volume.id, volume.root, row.updated_at,
    );
  }
  return {
    archiveItems: archiveItems.length,
    fileRows: fileRows.length,
    identities: identityRows.length,
    resolved: fileRows.length - unresolved.length,
    unresolved,
  };
}

function importOptionalRows(target, source) {
  const scan = source.prepare("SELECT * FROM archive_scan WHERE owner_id = ?").get(OWNER_ID);
  if (scan) {
    target.prepare(`
      INSERT INTO archive_scan
        (owner_id, status, started_at, completed_at, last_error, scanned_files, active_files,
         failed_files, duplicate_count, missing_count, quality_conflict_count, plex_only_count,
         local_only_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scan.owner_id, scan.status, scan.started_at, scan.completed_at, scan.last_error,
      scan.scanned_files, scan.active_files, scan.failed_files, scan.duplicate_count,
      scan.missing_count, scan.quality_conflict_count, scan.plex_only_count,
      scan.local_only_count, scan.updated_at,
    );
  }
  const reviews = source.prepare("SELECT * FROM archive_review WHERE owner_id = ? ORDER BY id").all(OWNER_ID);
  const insertReview = target.prepare(`
    INSERT INTO archive_review
      (id, owner_id, file_record_id, finding_type, evidence_key, status, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of reviews) {
    insertReview.run(row.id, row.owner_id, row.file_record_id, row.finding_type, row.evidence_key, row.status, row.note, row.created_at, row.updated_at);
  }
  return { scan: scan ? 1 : 0, reviews: reviews.length };
}

function verify(target, importedScan, imported) {
  const checks = {
    plex_item: count(target, "plex_item"),
    plex_show: count(target, "plex_show"),
    plex_episode: count(target, "plex_episode"),
    plex_media: count(target, "plex_media"),
    plex_part: count(target, "plex_part"),
    plex_library: count(target, "plex_library"),
    file_record: count(target, "file_record"),
    active_files: count(target, "file_record", "owner_id = '__local__' AND scan_status = 'active'"),
    error_files: count(target, "file_record", "owner_id = '__local__' AND scan_status = 'error'"),
    archive_item: count(target, "archive_item"),
    unowned_files: count(target, "file_record", "owner_id <> '__local__'"),
    resolved_files: count(target, "file_record", "local_identity_id IS NOT NULL"),
    unresolved_files: count(target, "file_record", "local_identity_id IS NULL"),
    archive_fk_misses: Number(target.prepare(`
      SELECT COUNT(*) AS count FROM file_record f
      LEFT JOIN archive_item a ON a.id = f.archive_item_id
      WHERE f.archive_item_id IS NOT NULL AND a.id IS NULL
    `).get().count),
    unknown_volume_files: count(target, "file_record", "volume_id IS NULL OR archive_root IS NULL"),
    foreign_key_errors: target.prepare("PRAGMA foreign_key_check").all().length,
  };
  if (importedScan) {
    const scan = target.prepare("SELECT scanned_files, active_files, failed_files FROM archive_scan WHERE owner_id = ?").get(OWNER_ID);
    const scannedFiles = Number(scan?.scanned_files);
    const activeFiles = Number(scan?.active_files);
    const failedFiles = Number(scan?.failed_files);
    if (
      !scan
      || ![scannedFiles, activeFiles, failedFiles].every((value) => Number.isInteger(value) && value >= 0)
      || activeFiles + failedFiles > scannedFiles
    ) {
      fail("imported archive_scan counters are missing or internally invalid");
    }
  }
  if (
    checks.plex_item !== EXPECTED.plex_item
    || checks.plex_show !== EXPECTED.plex_show
    || checks.plex_episode !== EXPECTED.plex_episode
    || checks.plex_media !== EXPECTED.plex_media
    || checks.plex_part !== EXPECTED.plex_part
    || checks.plex_library !== EXPECTED.plex_library
    || checks.file_record !== EXPECTED.file_record
    || checks.active_files !== EXPECTED.active_files
    || checks.error_files !== EXPECTED.error_files
    || checks.archive_item !== EXPECTED.archive_item
    || checks.unowned_files !== 0
    || checks.resolved_files + checks.unresolved_files !== imported.fileRows
    || checks.archive_fk_misses !== 0
    || checks.unknown_volume_files !== 0
    || checks.foreign_key_errors !== 0
  ) fail(`post-migration verification failed: ${JSON.stringify(checks)}`);
  if (imported.unresolved.length !== checks.unresolved_files) {
    fail("unresolved file records are not fully reportable");
  }
  return checks;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { target: targetPath, source: sourcePath } = requireExactPaths(args);
  const backupStamp = timestamp();
  const targetBackup = `${targetPath}.${backupStamp}.bak`;
  const sourceBackup = `${sourcePath}.${backupStamp}.bak`;
  backupDatabase(targetPath, targetBackup);
  backupDatabase(sourcePath, sourceBackup);

  const target = new DatabaseSync(targetPath);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    target.exec("PRAGMA foreign_keys = ON");
    ensureTargetSchema(target);
    assertExpectedCounts(target);
    assertSourcePreflight(source);
    target.exec(`ATTACH DATABASE '${sourcePath.replaceAll("'", "''")}' AS source_db`);
    assertNoIdCollisions(target);
    target.exec("BEGIN IMMEDIATE");
    try {
      const imported = importRows(target, source);
      const optional = importOptionalRows(target, source);
      const verification = verify(target, optional.scan === 1, imported);
      const unresolvedByReason = Object.fromEntries(
        imported.unresolved.reduce((counts, record) => {
          counts.set(record.reason, (counts.get(record.reason) ?? 0) + 1);
          return counts;
        }, new Map()),
      );
      target.exec("COMMIT");
      const report = {
        sourcePath,
        targetPath,
        backupPaths: { source: sourceBackup, target: targetBackup },
        countsBefore: { targetPlex: EXPECTED, sourceArchive: EXPECTED },
        countsAfter: verification,
        rowsInserted: {
          archiveItems: imported.archiveItems,
          fileRows: imported.fileRows,
          identities: imported.identities,
          resolvedIdentities: imported.resolved,
          unresolvedIdentities: imported.unresolved.length,
          ...optional,
        },
        unresolved: {
          resolvedIdentityCount: imported.resolved,
          unresolvedIdentityCount: imported.unresolved.length,
          countsByReason: unresolvedByReason,
          examples: {
            tv: imported.unresolved.filter((record) => record.mediaType === "tv").slice(0, 10),
            movie: imported.unresolved.filter((record) => record.mediaType === "movie").slice(0, 10),
          },
          records: imported.unresolved,
        },
        verification,
        rollback: `Stop the API and restore ${targetBackup} to ${targetPath}.`,
      };
      const reportPath = `${targetPath}.${backupStamp}.migration-report.json`;
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ reportPath, ...report }, null, 2));
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }
  } finally {
    try { target.exec("DETACH DATABASE source_db"); } catch {}
    source.close();
    target.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}
