import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const testDir = await mkdtemp(path.join(tmpdir(), "archive-assistant-tests-"));
const testFiles = ["ownership.test.ts", "integrations.test.ts", "integration-http.test.ts", "acquisition-jobs.test.ts"];
const outputFiles = testFiles.map((file) => path.join(testDir, file.replace(/\.ts$/, ".mjs")));
const databaseFile = path.join(testDir, "ownership.sqlite");

try {
  const legacyDb = new DatabaseSync(databaseFile);
  legacyDb.exec(`
    CREATE TABLE archive_item (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      source_id INTEGER,
      status TEXT NOT NULL DEFAULT 'planned',
      archive_path TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE plex_library (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      server_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE plex_item (
      id INTEGER PRIMARY KEY,
      library_id INTEGER NOT NULL REFERENCES plex_library(id) ON DELETE CASCADE,
      rating_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      item_type TEXT NOT NULL,
      year INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE plex_media (
      id INTEGER PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES plex_item(id) ON DELETE CASCADE,
      video_resolution TEXT,
      video_codec TEXT,
      audio_codec TEXT,
      bitrate INTEGER,
      duration_ms INTEGER
    );
    CREATE TABLE plex_part (
      id INTEGER PRIMARY KEY,
      media_id INTEGER NOT NULL REFERENCES plex_media(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      size_bytes INTEGER,
      checksum TEXT
    );
    CREATE TABLE source_record (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      source_type TEXT NOT NULL,
      location TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE download_job (
      id INTEGER PRIMARY KEY,
      source_id INTEGER,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE assistant_conversation (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New conversation',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE system_event (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE file_record (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      size_bytes INTEGER,
      checksum TEXT,
      media_type TEXT,
      discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE setting (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO archive_item (title) VALUES ('Legacy archive item');
    INSERT INTO plex_library (id, name, server_url) VALUES (1, 'Legacy Plex Library', 'http://legacy-plex');
    INSERT INTO plex_item (id, library_id, rating_key, title, item_type) VALUES (1, 1, 'legacy-rating', 'Legacy Plex Item', 'movie');
    INSERT INTO plex_media (id, item_id, video_resolution, video_codec) VALUES (1, 1, '1080', 'h264');
    INSERT INTO plex_part (id, media_id, file_path, size_bytes) VALUES (1, 1, '/legacy/movie.mkv', 1024);
    INSERT INTO source_record (label, source_type, location)
      VALUES ('Legacy source', 'url', 'https://example.com/source');
    INSERT INTO download_job (url) VALUES ('https://example.com/legacy');
    INSERT INTO assistant_conversation (title) VALUES ('Legacy conversation');
    INSERT INTO system_event (id, level, message, source, timestamp)
      VALUES ('legacy-event', 'info', 'Legacy event', 'legacy', CURRENT_TIMESTAMP);
    INSERT INTO file_record (path, size_bytes, checksum, media_type)
      VALUES ('/legacy/archive.mkv', 2048, 'legacy-checksum', 'matroska');
    INSERT INTO setting (key, value) VALUES ('plexServerUrl', '"http://legacy-plex"');
    INSERT INTO setting (key, value) VALUES ('plexToken', '"legacy-token"');
  `);
  legacyDb.close();

  await build({
    entryPoints: testFiles.map((file) => path.join(artifactDir, "test", file)),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outdir: testDir,
    outExtension: { ".js": ".mjs" },
    sourcemap: "inline",
    logLevel: "warning",
  });

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--test", "--test-concurrency=1", ...outputFiles.map((file) => pathToFileURL(file).pathname)],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          ARCHIVE_DB_PATH: databaseFile,
          ARCHIVE_TEST_ROOT: testDir,
        },
      },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(testDir, { recursive: true, force: true });
}