import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runtimeConfig } from "./runtime-config";

export const LEGACY_OWNER_ID = "__legacy__";

const dbPath = runtimeConfig.databasePath;

mkdirSync(dirname(dbPath), { recursive: true });

export const archiveDb = new DatabaseSync(dbPath);

archiveDb.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS plex_library (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    server_url TEXT NOT NULL,
    library_key TEXT NOT NULL DEFAULT '',
    library_type TEXT NOT NULL DEFAULT 'unknown',
    owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}',
    item_count INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    sync_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS plex_item (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL REFERENCES plex_library(id) ON DELETE CASCADE,
    rating_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    item_type TEXT NOT NULL,
    year INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}',
    thumb_url TEXT,
    added_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_id, rating_key)
  );
  CREATE TABLE IF NOT EXISTS plex_media (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES plex_item(id) ON DELETE CASCADE,
    video_resolution TEXT,
    video_codec TEXT,
    audio_codec TEXT,
    bitrate INTEGER,
    duration_ms INTEGER
  );
  CREATE TABLE IF NOT EXISTS plex_part (
    id INTEGER PRIMARY KEY,
    media_id INTEGER NOT NULL REFERENCES plex_media(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    size_bytes INTEGER,
    checksum TEXT
  );
  CREATE INDEX IF NOT EXISTS plex_media_item_id_idx ON plex_media(item_id);
  CREATE INDEX IF NOT EXISTS plex_part_media_id_idx ON plex_part(media_id);
  CREATE TABLE IF NOT EXISTS plex_show (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL UNIQUE REFERENCES plex_item(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}',
    rating_key TEXT NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_id, rating_key)
  );
  CREATE TABLE IF NOT EXISTS plex_season (
    id INTEGER PRIMARY KEY,
    show_id INTEGER NOT NULL REFERENCES plex_show(id) ON DELETE CASCADE,
    rating_key TEXT,
    season_number INTEGER NOT NULL,
    title TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (show_id, season_number)
  );
  CREATE TABLE IF NOT EXISTS plex_episode (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL UNIQUE REFERENCES plex_item(id) ON DELETE CASCADE,
    season_id INTEGER REFERENCES plex_season(id) ON DELETE SET NULL,
    owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}',
    rating_key TEXT NOT NULL,
    episode_number INTEGER,
    title TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_id, rating_key)
  );
  CREATE TABLE IF NOT EXISTS archive_item (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    source_id INTEGER,
    status TEXT NOT NULL DEFAULT 'planned',
    archive_path TEXT,
    owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS source_record (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    source_type TEXT NOT NULL,
    location TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS download_job (
    id INTEGER PRIMARY KEY,
    source_id INTEGER REFERENCES source_record(id),
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    progress REAL NOT NULL DEFAULT 0,
    owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS processing_job (
    id INTEGER PRIMARY KEY,
    archive_item_id INTEGER REFERENCES archive_item(id),
    processor TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    progress REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS queue_item (
    id INTEGER PRIMARY KEY,
    job_type TEXT NOT NULL,
    job_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS acquisition_job (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    external_id TEXT,
    source_id TEXT,
    source_url TEXT,
    provider_id TEXT,
    provider_job_id TEXT,
    provider_reference TEXT,
    download_job_id INTEGER REFERENCES download_job(id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'planned',
    current_phase TEXT NOT NULL DEFAULT 'planned',
    progress REAL NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    error_code TEXT,
    error_message TEXT,
    request_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    planned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    searching_at TEXT,
    source_selected_at TEXT,
    downloading_at TEXT,
    processing_at TEXT,
    verifying_at TEXT,
    importing_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS acquisition_job_owner_state_idx
    ON acquisition_job(owner_id, state, updated_at DESC);
  CREATE TABLE IF NOT EXISTS acquisition_job_event (
    id INTEGER PRIMARY KEY,
    acquisition_job_id INTEGER NOT NULL REFERENCES acquisition_job(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    detail TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS acquisition_job_event_job_idx
    ON acquisition_job_event(acquisition_job_id, created_at ASC, id ASC);
  CREATE TABLE IF NOT EXISTS file_record (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    size_bytes INTEGER,
    checksum TEXT,
    media_type TEXT,
    discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}',
    archive_item_id INTEGER REFERENCES archive_item(id),
    filename TEXT NOT NULL DEFAULT '',
    relative_path TEXT NOT NULL DEFAULT '',
    scan_status TEXT NOT NULL DEFAULT 'active',
    last_seen_at TEXT,
    modified_at_ms INTEGER,
    extension TEXT NOT NULL DEFAULT '',
    duration_seconds REAL,
    video_codec TEXT,
    audio_codec TEXT,
    width INTEGER,
    height INTEGER,
    fps REAL,
    bitrate INTEGER,
    container TEXT,
    dynamic_range TEXT,
    audio_channels INTEGER,
    audio_languages TEXT NOT NULL DEFAULT '[]',
    subtitle_languages TEXT NOT NULL DEFAULT '[]',
    fingerprint TEXT,
    error_message TEXT,
    local_identity_id INTEGER REFERENCES local_media_identity(id),
    volume_id TEXT,
    archive_root TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_id, path)
  );
  CREATE TABLE IF NOT EXISTS local_media_identity (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}',
    identity_key TEXT NOT NULL,
    media_type TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    year INTEGER,
    show_identity TEXT,
    season_number INTEGER,
    episode_number INTEGER,
    size_bytes INTEGER,
    fingerprint TEXT,
    checksum TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_id, identity_key)
  );
  CREATE TABLE IF NOT EXISTS archive_scan (
    owner_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'not_scanned',
    started_at TEXT,
    completed_at TEXT,
    last_error TEXT,
    scanned_files INTEGER NOT NULL DEFAULT 0,
    active_files INTEGER NOT NULL DEFAULT 0,
    failed_files INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    missing_count INTEGER NOT NULL DEFAULT 0,
    quality_conflict_count INTEGER NOT NULL DEFAULT 0,
    plex_only_count INTEGER NOT NULL DEFAULT 0,
    local_only_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS archive_review (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL,
    file_record_id INTEGER NOT NULL REFERENCES file_record(id) ON DELETE CASCADE,
    finding_type TEXT NOT NULL,
    evidence_key TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_id, file_record_id, finding_type, evidence_key)
  );
  CREATE TABLE IF NOT EXISTS review_item (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT NOT NULL DEFAULT '{}',
    note TEXT,
    decision_at TEXT,
    decided_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_id, kind, subject_key)
  );
  CREATE INDEX IF NOT EXISTS review_item_owner_state_idx
    ON review_item(owner_id, state, updated_at DESC);
  CREATE TABLE IF NOT EXISTS review_item_decision (
    id INTEGER PRIMARY KEY,
    review_item_id INTEGER NOT NULL REFERENCES review_item(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    note TEXT,
    decided_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS review_item_decision_item_idx
    ON review_item_decision(review_item_id, created_at ASC, id ASC);
  CREATE TABLE IF NOT EXISTS acquisition_recommendation (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL,
    recommendation_key TEXT NOT NULL,
    media_type TEXT NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    external_id TEXT,
    target_json TEXT NOT NULL DEFAULT '{}',
    evidence_json TEXT NOT NULL DEFAULT '{}',
    quality_json TEXT NOT NULL DEFAULT '{}',
    destination_json TEXT NOT NULL DEFAULT '{}',
    route_json TEXT NOT NULL DEFAULT '{}',
    blockers_json TEXT NOT NULL DEFAULT '[]',
    confidence TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    review_item_id INTEGER REFERENCES review_item(id) ON DELETE SET NULL,
    acquisition_job_id INTEGER REFERENCES acquisition_job(id) ON DELETE SET NULL,
    evidence_hash TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_id, recommendation_key, evidence_hash)
  );
  CREATE INDEX IF NOT EXISTS acquisition_recommendation_owner_idx
    ON acquisition_recommendation(owner_id, status, updated_at DESC);
  CREATE TABLE IF NOT EXISTS archive_operation (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    action TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_id TEXT,
    source_path TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    review_item_id INTEGER NOT NULL REFERENCES review_item(id),
    acquisition_job_id INTEGER REFERENCES acquisition_job(id) ON DELETE SET NULL,
    download_job_id INTEGER REFERENCES download_job(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    dry_run INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    preflight_json TEXT NOT NULL DEFAULT '{}',
    rollback_json TEXT NOT NULL DEFAULT '{}',
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (owner_id, operation_key)
  );
  CREATE INDEX IF NOT EXISTS archive_operation_owner_idx
    ON archive_operation(owner_id, status, updated_at DESC);
  CREATE TABLE IF NOT EXISTS archive_operation_event (
    id INTEGER PRIMARY KEY,
    operation_id INTEGER NOT NULL REFERENCES archive_operation(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    detail TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS archive_operation_event_idx
    ON archive_operation_event(operation_id, created_at ASC, id ASC);
  CREATE TABLE IF NOT EXISTS assistant_conversation (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New conversation',
    owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS assistant_message (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES assistant_conversation(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS system_event (
    id TEXT PRIMARY KEY,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    source TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    operator_id TEXT,
    retention_class TEXT NOT NULL DEFAULT 'operational'
  );
  CREATE TABLE IF NOT EXISTS setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_setting (
    owner_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_id, key)
  );
  CREATE TABLE IF NOT EXISTS ownership_migration (
    key TEXT PRIMARY KEY,
    claimed_by TEXT NOT NULL,
    claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

function ensureColumn(table: string, column: string, definition: string) {
  const columns = archiveDb
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    archiveDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Phase 2/3 migrations are additive so an existing Phase 1 database is retained.
const downloadColumns: Array<[string, string]> = [
  ["source_url", "TEXT"],
  ["source_site", "TEXT"],
  ["source_id_text", "TEXT"],
  ["title", "TEXT NOT NULL DEFAULT 'Untitled media'"],
  ["selected_format_id", "TEXT NOT NULL DEFAULT 'best'"],
  ["selected_video_format_id", "TEXT"],
  ["selected_audio_format_id", "TEXT"],
  ["output_container", "TEXT NOT NULL DEFAULT 'mp4'"],
  ["temporary_directory", "TEXT NOT NULL DEFAULT ''"],
  ["destination_directory", "TEXT NOT NULL DEFAULT ''"],
  ["final_filename", "TEXT NOT NULL DEFAULT 'download'"],
  ["final_path", "TEXT"],
  ["total_bytes", "INTEGER"],
  ["downloaded_bytes", "INTEGER NOT NULL DEFAULT 0"],
  ["download_speed", "REAL"],
  ["eta_seconds", "INTEGER"],
  ["started_at", "TEXT"],
  ["completed_at", "TEXT"],
  ["error_message", "TEXT"],
  ["retry_count", "INTEGER NOT NULL DEFAULT 0"],
  ["process_id", "INTEGER"],
  ["current_phase", "TEXT NOT NULL DEFAULT 'queued'"],
  ["verification", "TEXT NOT NULL DEFAULT 'waiting'"],
  ["updated_at", "TEXT NOT NULL DEFAULT ''"],
];
for (const [column, definition] of downloadColumns) {
  ensureColumn("download_job", column, definition);
}
const processingColumns: Array<[string, string]> = [
  ["download_job_id", "INTEGER"],
  ["input_file", "TEXT"],
  ["output_file", "TEXT"],
  ["operation", "TEXT NOT NULL DEFAULT 'verify'"],
  ["started_at", "TEXT"],
  ["completed_at", "TEXT"],
  ["error_message", "TEXT"],
  ["updated_at", "TEXT NOT NULL DEFAULT ''"],
];
for (const [column, definition] of processingColumns) {
  ensureColumn("processing_job", column, definition);
}
archiveDb.exec(`
  UPDATE download_job SET updated_at = CURRENT_TIMESTAMP WHERE updated_at = '';
  UPDATE processing_job SET updated_at = CURRENT_TIMESTAMP WHERE updated_at = '';

  CREATE TRIGGER IF NOT EXISTS download_job_set_updated_at_after_insert
  AFTER INSERT ON download_job
  WHEN NEW.updated_at = ''
  BEGIN
    UPDATE download_job SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS processing_job_set_updated_at_after_insert
  AFTER INSERT ON processing_job
  WHEN NEW.updated_at = ''
  BEGIN
    UPDATE processing_job SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;
`);
for (const [column, definition] of [
  ["library_key", "TEXT NOT NULL DEFAULT ''"],
  ["library_type", "TEXT NOT NULL DEFAULT 'unknown'"],
  ["owner_id", `TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}'`],
  ["item_count", "INTEGER NOT NULL DEFAULT 0"],
  ["last_synced_at", "TEXT"],
  ["sync_status", "TEXT NOT NULL DEFAULT 'pending'"],
  ["sync_error", "TEXT"],
] as Array<[string, string]>) {
  ensureColumn("plex_library", column, definition);
}
for (const [column, definition] of [
  ["owner_id", `TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}'`],
  ["thumb_url", "TEXT"],
  ["added_at", "TEXT"],
  ["updated_at", "TEXT NOT NULL DEFAULT ''"],
  ["local_identity_id", "INTEGER REFERENCES local_media_identity(id)"],
  ["volume_id", "TEXT"],
  ["archive_root", "TEXT"],
] as Array<[string, string]>) {
  ensureColumn("plex_item", column, definition);
}
archiveDb.exec("UPDATE plex_item SET updated_at = CURRENT_TIMESTAMP WHERE updated_at = ''");

function hasSingleColumnUniqueIndex(table: string, column: string) {
  const indexes = archiveDb
    .prepare(`PRAGMA index_list(${table})`)
    .all() as Array<{ name: string; unique: number }>;
  return indexes.some((index) => {
    if (!index.unique) return false;
    const indexName = index.name.replaceAll('"', '""');
    const columns = archiveDb
      .prepare(`PRAGMA index_info("${indexName}")`)
      .all() as Array<{ name: string }>;
    return columns.length === 1 && columns[0]?.name === column;
  });
}

// The original Plex item schema had a global UNIQUE(rating_key). Rebuild only
// this table in place so the same Plex rating key can safely exist for two
// authenticated owners while preserving all existing rows and child records.
if (hasSingleColumnUniqueIndex("plex_item", "rating_key")) {
  archiveDb.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE plex_item_owned (
      id INTEGER PRIMARY KEY,
      library_id INTEGER NOT NULL REFERENCES plex_library(id) ON DELETE CASCADE,
      rating_key TEXT NOT NULL,
      title TEXT NOT NULL,
      item_type TEXT NOT NULL,
      year INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}',
      thumb_url TEXT,
      added_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (owner_id, rating_key)
    );
    INSERT INTO plex_item_owned
      (id, library_id, rating_key, title, item_type, year, metadata_json, owner_id, thumb_url, added_at, updated_at)
      SELECT id, library_id, rating_key, title, item_type, year, metadata_json, owner_id, thumb_url, added_at,
        CASE WHEN updated_at = '' THEN CURRENT_TIMESTAMP ELSE updated_at END
      FROM plex_item;
    DROP TABLE plex_item;
    ALTER TABLE plex_item_owned RENAME TO plex_item;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
const fileRecordColumns = archiveDb
  .prepare("PRAGMA table_info(file_record)")
  .all() as Array<{ name: string }>;
const fileRecordHasOwner = fileRecordColumns.some((column) => column.name === "owner_id");
if (!fileRecordHasOwner || hasSingleColumnUniqueIndex("file_record", "path")) {
  const ownerExpression = fileRecordHasOwner ? "owner_id" : `'${LEGACY_OWNER_ID}'`;
  archiveDb.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE file_record_owned (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      size_bytes INTEGER,
      checksum TEXT,
      media_type TEXT,
      discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      owner_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}',
      archive_item_id INTEGER REFERENCES archive_item(id),
      filename TEXT NOT NULL DEFAULT '',
      relative_path TEXT NOT NULL DEFAULT '',
      scan_status TEXT NOT NULL DEFAULT 'active',
      last_seen_at TEXT,
      modified_at_ms INTEGER,
      extension TEXT NOT NULL DEFAULT '',
      duration_seconds REAL,
      video_codec TEXT,
      audio_codec TEXT,
      width INTEGER,
      height INTEGER,
      fps REAL,
      bitrate INTEGER,
      container TEXT,
      dynamic_range TEXT,
      audio_channels INTEGER,
      audio_languages TEXT NOT NULL DEFAULT '[]',
      subtitle_languages TEXT NOT NULL DEFAULT '[]',
      fingerprint TEXT,
      error_message TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (owner_id, path)
    );
    INSERT INTO file_record_owned
      (id, path, size_bytes, checksum, media_type, discovered_at, owner_id)
    SELECT id, path, size_bytes, checksum, media_type, discovered_at, ${ownerExpression}
    FROM file_record;
    DROP TABLE file_record;
    ALTER TABLE file_record_owned RENAME TO file_record;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
for (const [column, definition] of [
  ["owner_id", `TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}'`],
  ["archive_item_id", "INTEGER"],
  ["filename", "TEXT NOT NULL DEFAULT ''"],
  ["relative_path", "TEXT NOT NULL DEFAULT ''"],
  ["scan_status", "TEXT NOT NULL DEFAULT 'active'"],
  ["last_seen_at", "TEXT"],
  ["modified_at_ms", "INTEGER"],
  ["extension", "TEXT NOT NULL DEFAULT ''"],
  ["duration_seconds", "REAL"],
  ["video_codec", "TEXT"],
  ["audio_codec", "TEXT"],
  ["width", "INTEGER"],
  ["height", "INTEGER"],
  ["fps", "REAL"],
  ["bitrate", "INTEGER"],
  ["container", "TEXT"],
  ["dynamic_range", "TEXT"],
  ["audio_channels", "INTEGER"],
  ["audio_languages", "TEXT NOT NULL DEFAULT '[]'"],
  ["subtitle_languages", "TEXT NOT NULL DEFAULT '[]'"],
  ["fingerprint", "TEXT"],
  ["error_message", "TEXT"],
  ["local_identity_id", "INTEGER"],
  ["volume_id", "TEXT"],
  ["archive_root", "TEXT"],
  ["updated_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"],
] as Array<[string, string]>) {
  ensureColumn("file_record", column, definition);
}
archiveDb.exec(`
  CREATE INDEX IF NOT EXISTS file_record_local_identity_idx ON file_record(local_identity_id);
  CREATE INDEX IF NOT EXISTS local_media_identity_owner_type_idx ON local_media_identity(owner_id, media_type);
`);
ensureColumn("archive_scan", "owner_id", `TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}'`);
for (const table of ["archive_item", "source_record", "download_job", "assistant_conversation", "system_event", "plex_library", "plex_item"]) {
  ensureColumn(table, "owner_id", `TEXT NOT NULL DEFAULT '${LEGACY_OWNER_ID}'`);
}
ensureColumn("system_event", "operator_id", "TEXT");
ensureColumn("system_event", "retention_class", "TEXT NOT NULL DEFAULT 'operational'");
archiveDb.exec(`
  UPDATE system_event
  SET retention_class = 'security'
  WHERE source = 'integrations'
    AND message LIKE 'Webhook secret rotated for %'
    AND retention_class <> 'security';

  CREATE INDEX IF NOT EXISTS system_event_owner_timestamp_idx
    ON system_event(owner_id, timestamp DESC, id DESC);
`);

const defaultSettings = {
  mockMode: runtimeConfig.mockMode,
  dataDirectory: runtimeConfig.paths.data,
  downloadDirectory: runtimeConfig.paths.downloads,
  archiveDirectory:
  process.platform === "win32"
    ? [
        "D:\\Movies",
        "D:\\Tv Shows",
        "E:\\Movies",
        "E:\\Tv Shows",
      ].join("\n")
    : runtimeConfig.paths.archive,
  temporaryDirectory: runtimeConfig.paths.temporary,
  ytDlpPath: runtimeConfig.tools.ytDlp,
  ffmpegPath: runtimeConfig.tools.ffmpeg,
  ffprobePath: runtimeConfig.tools.ffprobe,
  logLevel: "info",
  hardwareAcceleration: true,
  hardwareAccelerationMode: "auto",
  networkMode: "local_only",
  concurrentDownloads: 2,
  maxRetries: 2,
  bandwidthLimit: 0,
  outputContainer: "mp4",
  inspectionCacheMinutes: 15,
  archiveScanConcurrency: 4,
  warningFreePercent: 15,
  criticalFreePercent: 5,
} as const;

const settingStatement = archiveDb.prepare(
  "INSERT OR IGNORE INTO setting (key, value) VALUES (?, ?)",
);
for (const [key, value] of Object.entries(defaultSettings)) {
  settingStatement.run(key, JSON.stringify(value));
}
if (process.platform === "win32") {
  archiveDb
    .prepare(
      "UPDATE setting SET value = ? WHERE key = 'archiveDirectory'",
    )
    .run(JSON.stringify(defaultSettings.archiveDirectory));
}

const eventCount = archiveDb
  .prepare("SELECT COUNT(*) AS count FROM system_event")
  .get() as { count: number };
if (eventCount.count === 0) {
  const insertEvent = archiveDb.prepare(
    "INSERT INTO system_event (id, level, message, source, timestamp) VALUES (?, ?, ?, ?, ?)",
  );
  insertEvent.run(
    "evt-db-ready",
    "success",
    "Local SQLite database initialized",
    "database",
    new Date().toISOString(),
  );
  insertEvent.run(
    "evt-mock-mode",
    "info",
    "Mock mode is active; external services are not contacted",
    "runtime",
    new Date(Date.now() - 1000 * 60 * 4).toISOString(),
  );
}

export type SettingsRecord = typeof defaultSettings;

const legacyOwnedTables = [
  "archive_item",
  "source_record",
  "download_job",
  "assistant_conversation",
  "system_event",
  "plex_library",
  "plex_item",
  "file_record",
] as const;

export function claimLegacyData(ownerId: string) {
  if (!ownerId || ownerId === LEGACY_OWNER_ID) {
    throw new Error("A valid authenticated owner is required.");
  }

  const existingClaim = archiveDb
    .prepare("SELECT claimed_by FROM ownership_migration WHERE key = 'legacy_owner'")
    .get() as { claimed_by: string } | undefined;
  if (existingClaim) return existingClaim.claimed_by;

  archiveDb.exec("BEGIN IMMEDIATE");
  try {
    const claim = archiveDb
      .prepare("SELECT claimed_by FROM ownership_migration WHERE key = 'legacy_owner'")
      .get() as { claimed_by: string } | undefined;
    if (claim) {
      archiveDb.exec("COMMIT");
      return claim.claimed_by;
    }

    for (const table of legacyOwnedTables) {
      archiveDb
        .prepare(`UPDATE ${table} SET owner_id = ? WHERE owner_id = ?`)
        .run(ownerId, LEGACY_OWNER_ID);
    }

    const legacyPlexSettings = archiveDb
      .prepare("SELECT key, value FROM setting WHERE key IN ('plexServerUrl', 'plexToken')")
      .all() as Array<{ key: string; value: string }>;
    const userSetting = archiveDb.prepare(
      "INSERT INTO user_setting (owner_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
    );
    for (const row of legacyPlexSettings) {
      userSetting.run(ownerId, row.key, row.value);
    }
    if (legacyPlexSettings.length) {
      archiveDb.prepare("DELETE FROM setting WHERE key IN ('plexServerUrl', 'plexToken')").run();
    }

    archiveDb
      .prepare("INSERT INTO ownership_migration (key, claimed_by) VALUES ('legacy_owner', ?)")
      .run(ownerId);
    archiveDb.exec("COMMIT");
    return ownerId;
  } catch (error) {
    archiveDb.exec("ROLLBACK");
    throw error;
  }
}

export function readSettings(): SettingsRecord {
  const rows = archiveDb
    .prepare("SELECT key, value FROM setting")
    .all() as Array<{ key: string; value: string }>;
  const result = { ...defaultSettings } as Record<string, unknown>;
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  }
  return result as SettingsRecord;
}

export function writeSettings(updates: Record<string, unknown>): SettingsRecord {
  const statement = archiveDb.prepare(
    "INSERT INTO setting (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
  );
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) statement.run(key, JSON.stringify(value));
  }
  return readSettings();
}

export const SYSTEM_EVENT_RETENTION = {
  operationalDays: 30,
  security: "indefinite",
} as const;

export type SystemEventRetentionClass = "operational" | "security";

export function pruneSystemEvents(ownerId: string, now = Date.now()) {
  if (!ownerId) {
    throw new Error("A valid event owner is required.");
  }
  const cutoff = new Date(
    now - SYSTEM_EVENT_RETENTION.operationalDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = archiveDb
    .prepare(
      "DELETE FROM system_event WHERE owner_id = ? AND retention_class = 'operational' AND timestamp < ?",
    )
    .run(ownerId, cutoff);
  return Number(result.changes);
}

export function readEvents(ownerId: string, limit = 12) {
  return archiveDb
    .prepare(
      "SELECT id, level, message, timestamp, source, operator_id AS operatorId, retention_class AS retentionClass FROM system_event WHERE owner_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?",
    )
    .all(ownerId, limit) as Array<{
    id: string;
    level: "info" | "success" | "warning" | "error";
    message: string;
    timestamp: string;
    source: string;
    operatorId: string | null;
    retentionClass: SystemEventRetentionClass;
  }>;
}

export function addEvent(
  level: "info" | "success" | "warning" | "error",
  message: string,
  source: string,
  ownerId = LEGACY_OWNER_ID,
  operatorId: string | null = null,
  timestamp = new Date().toISOString(),
  retentionClass: SystemEventRetentionClass = "operational",
) {
  if (retentionClass !== "operational" && retentionClass !== "security") {
    throw new Error("System event retention class is not supported.");
  }
  const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  archiveDb
    .prepare(
      "INSERT INTO system_event (id, level, message, source, timestamp, owner_id, operator_id, retention_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, level, message, source, timestamp, ownerId, operatorId, retentionClass);
}

export function readUserSetting(ownerId: string, key: string) {
  const row = archiveDb
    .prepare("SELECT value FROM user_setting WHERE owner_id = ? AND key = ?")
    .get(ownerId, key) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return row.value;
  }
}

export function writeUserSetting(ownerId: string, key: string, value: unknown) {
  archiveDb
    .prepare(
      "INSERT INTO user_setting (owner_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
    )
    .run(ownerId, key, JSON.stringify(value));
}