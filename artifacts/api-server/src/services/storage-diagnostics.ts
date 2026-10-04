import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { archiveDb } from "../lib/archive-db";
import { runtimeConfig } from "../lib/runtime-config";

// ---------------------------------------------------------------------------
// Storage diagnostics
//
// A packaged Windows run reported ~37,572 active files in the UI while the
// database at %LOCALAPPDATA%\com.imlochie.archiveassistant\ held 12 rows when
// inspected later. That discrepancy is unresolvable by reading code, because
// the question is which file the running process actually opened — which
// depends on the environment the sidecar was launched with, not on the source.
//
// This module answers that question from inside the live process: the resolved
// database path, whether ARCHIVE_DB_PATH supplied it or it fell back to the
// working directory, and the row counts SQLite itself reports for that
// connection. If the UI shows large numbers and this reports a small file, the
// process is writing somewhere other than where it is being inspected.
//
// Strictly read-only. It opens nothing, migrates nothing, and never reports
// secrets: only paths, booleans and counts.
// ---------------------------------------------------------------------------

/**
 * When ARCHIVE_DB_PATH is absent, runtime-config falls back to
 * `${process.cwd()}/data/archive-assistant.sqlite`. In a packaged Windows
 * install the working directory is whatever the shell happened to launch with,
 * so that fallback silently produces a different database per launch context.
 * Reporting which branch was taken is the point of this diagnostic.
 */
export function databasePathSource(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.ARCHIVE_DB_PATH;
  if (configured !== undefined && configured.trim() !== "") return "ARCHIVE_DB_PATH" as const;
  return "working_directory_fallback" as const;
}

export interface StorageDiagnostics {
  /** Absolute path of the database this process has open. */
  databasePath: string;
  /** Whether the path came from the environment or from the cwd fallback. */
  databasePathSource: "ARCHIVE_DB_PATH" | "working_directory_fallback";
  /** Absolute paths are required in a packaged install; a relative one is a bug. */
  databasePathIsAbsolute: boolean;
  /** The process working directory, which determines the fallback path. */
  workingDirectory: string;
  /** Size on disk, or null when the file cannot be stated. */
  databaseSizeBytes: number | null;
  /** Row counts from this connection, so UI numbers can be compared directly. */
  counts: {
    fileRecords: number;
    activeFileRecords: number;
    plexItems: number;
    jellyfinItems: number;
    reviewItems: number;
    archiveOperations: number;
    settings: number;
  };
  /** True when Plex credentials are present, never the credentials themselves. */
  plexConfigured: boolean;
  /** SQLite journal mode; WAL means recent writes may sit in a sidecar file. */
  journalMode: string | null;
  /** Names of any WAL/SHM sidecar files present next to the database. */
  walSidecars: string[];
}

function count(sql: string): number {
  try {
    const row = archiveDb.prepare(sql).get() as { value?: number } | undefined;
    return Number(row?.value ?? 0);
  } catch {
    // A table may not exist on an older database. Report zero rather than
    // failing the whole diagnostic.
    return 0;
  }
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export function readStorageDiagnostics(): StorageDiagnostics {
  const databasePath = runtimeConfig.databasePath;

  let journalMode: string | null = null;
  try {
    const row = archiveDb.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    journalMode = row?.journal_mode ?? null;
  } catch {
    journalMode = null;
  }

  // In WAL mode a committed write can live in -wal until a checkpoint, so an
  // external reader opening only the main file may legitimately see less data.
  // Report which sidecars exist so that explanation can be confirmed or ruled
  // out rather than assumed.
  const walSidecars = ["-wal", "-shm"]
    .filter((suffix) => sizeOf(`${databasePath}${suffix}`) !== null)
    .map((suffix) => `${suffix.slice(1)}`);

  const plexConfigured = count(
    "SELECT COUNT(*) AS value FROM setting WHERE key IN ('plexServerUrl', 'plexToken')",
  ) > 0
    || count(
      "SELECT COUNT(*) AS value FROM user_setting WHERE key IN ('plexServerUrl', 'plexToken')",
    ) > 0;

  return {
    databasePath,
    databasePathSource: databasePathSource(),
    databasePathIsAbsolute: isAbsolute(databasePath),
    workingDirectory: process.cwd(),
    databaseSizeBytes: sizeOf(databasePath),
    counts: {
      fileRecords: count("SELECT COUNT(*) AS value FROM file_record"),
      activeFileRecords: count(
        "SELECT COUNT(*) AS value FROM file_record WHERE scan_status = 'active'",
      ),
      plexItems: count("SELECT COUNT(*) AS value FROM plex_item"),
      jellyfinItems: count("SELECT COUNT(*) AS value FROM jellyfin_item"),
      reviewItems: count("SELECT COUNT(*) AS value FROM review_item"),
      archiveOperations: count("SELECT COUNT(*) AS value FROM archive_operation"),
      settings: count("SELECT COUNT(*) AS value FROM setting"),
    },
    plexConfigured,
    journalMode,
    walSidecars,
  };
}
