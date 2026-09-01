import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath =
  process.env.ARCHIVE_DB_PATH ??
  join(process.cwd(), "data", "archive-assistant.sqlite");

mkdirSync(dirname(dbPath), { recursive: true });

export const archiveDb = new DatabaseSync(dbPath);

archiveDb.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS plex_library (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    server_url TEXT NOT NULL,
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
    metadata_json TEXT NOT NULL DEFAULT '{}'
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
  CREATE TABLE IF NOT EXISTS archive_item (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    source_id INTEGER,
    status TEXT NOT NULL DEFAULT 'planned',
    archive_path TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS source_record (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    source_type TEXT NOT NULL,
    location TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS download_job (
    id INTEGER PRIMARY KEY,
    source_id INTEGER REFERENCES source_record(id),
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    progress REAL NOT NULL DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS file_record (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    size_bytes INTEGER,
    checksum TEXT,
    media_type TEXT,
    discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS assistant_conversation (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New conversation',
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
    timestamp TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const defaultSettings = {
  mockMode: true,
  dataDirectory: "~/ARCHIVE/data",
  downloadDirectory: "~/ARCHIVE/downloads",
  archiveDirectory: "~/ARCHIVE/library",
  logLevel: "info",
  hardwareAcceleration: true,
  networkMode: "local_only",
} as const;

const settingStatement = archiveDb.prepare(
  "INSERT OR IGNORE INTO setting (key, value) VALUES (?, ?)",
);
for (const [key, value] of Object.entries(defaultSettings)) {
  settingStatement.run(key, JSON.stringify(value));
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

export function readEvents(limit = 12) {
  return archiveDb
    .prepare(
      "SELECT id, level, message, timestamp, source FROM system_event ORDER BY timestamp DESC LIMIT ?",
    )
    .all(limit) as Array<{
    id: string;
    level: "info" | "success" | "warning" | "error";
    message: string;
    timestamp: string;
    source: string;
  }>;
}