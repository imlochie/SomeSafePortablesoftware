import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const testDir = await mkdtemp(path.join(tmpdir(), "archive-assistant-tests-"));
const outputFile = path.join(testDir, "ownership.test.mjs");
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
    CREATE TABLE setting (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO archive_item (title) VALUES ('Legacy archive item');
    INSERT INTO source_record (label, source_type, location)
      VALUES ('Legacy source', 'url', 'https://example.com/source');
    INSERT INTO download_job (url) VALUES ('https://example.com/legacy');
    INSERT INTO assistant_conversation (title) VALUES ('Legacy conversation');
    INSERT INTO system_event (id, level, message, source, timestamp)
      VALUES ('legacy-event', 'info', 'Legacy event', 'legacy', CURRENT_TIMESTAMP);
    INSERT INTO setting (key, value) VALUES ('plexServerUrl', '"http://legacy-plex"');
    INSERT INTO setting (key, value) VALUES ('plexToken', '"legacy-token"');
  `);
  legacyDb.close();

  await build({
    entryPoints: [path.join(artifactDir, "test", "ownership.test.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: outputFile,
    sourcemap: "inline",
    logLevel: "warning",
  });

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--test", pathToFileURL(outputFile).pathname],
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