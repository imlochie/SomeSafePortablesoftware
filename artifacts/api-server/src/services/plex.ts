import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { archiveDb, addEvent, readSettings, readUserSetting, writeUserSetting } from "../lib/archive-db";
import { invalidateArchiveInventoryCache } from "./archive";

const requestTimeoutMs = 15_000;
const plexPersistenceBatchSize = 100;
const syncs = new Map<string, Promise<void>>();

type PlexRecord = Record<string, unknown>;

export type PlexState =
  | "not_configured"
  | "configured"
  | "connection_failed"
  | "connected"
  | "syncing"
  | "synced"
  | "sync_error";

export class PlexConfigurationError extends Error {}

class PlexRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlexRequestError";
  }
}

function asRecord(value: unknown): PlexRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as PlexRecord : {};
}

function asArray(value: unknown): PlexRecord[] {
  if (Array.isArray(value)) return value.map(asRecord);
  return value && typeof value === "object" ? [asRecord(value)] : [];
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeServerUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  const candidate = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new PlexConfigurationError("Enter a valid Plex server URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new PlexConfigurationError("Plex server URL must use HTTP or HTTPS without embedded credentials.");
  }
  return candidate;
}

function readPlexCredentials(ownerId: string) {
  const serverUrl = normalizeServerUrl(readUserSetting(ownerId, "plexServerUrl"));
  const token = readUserSetting(ownerId, "plexToken");
  return {
    serverUrl,
    token: typeof token === "string" ? token.trim() : "",
  };
}

function publicError(error: unknown) {
  if (error instanceof PlexConfigurationError || error instanceof PlexRequestError) return error.message;
  return "Plex synchronization failed unexpectedly. Check the local API event log.";
}

function containerFrom(value: unknown) {
  const root = asRecord(value);
  return asRecord(root.MediaContainer ?? root.mediaContainer ?? root);
}

type ValidatedTarget = { url: URL; address: string; family: 4 | 6 };

async function requestJson(target: ValidatedTarget, token: string, path: string) {
  const relative = new URL(path, "http://plex.local");
  const requestPath = `${target.url.pathname.replace(/\/$/, "")}${relative.pathname}${relative.search}`;
  return new Promise<unknown>((resolve, reject) => {
    const options = {
      hostname: target.address,
      family: target.family,
      port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
      path: requestPath,
      method: "GET",
      headers: {
        Accept: "application/json",
        Host: target.url.host,
        "X-Plex-Token": token,
        "X-Plex-Client-Identifier": "archive-assistant",
        "X-Plex-Product": "Archive Assistant",
      },
    };
    const handleResponse = (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let byteCount = 0;
      response.on("data", (chunk: Buffer) => {
        byteCount += chunk.length;
        if (byteCount > 64 * 1024 * 1024) {
          response.destroy(new PlexRequestError("Plex returned a response larger than 64 MB."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", (error) => reject(error instanceof PlexRequestError
        ? error
        : new PlexRequestError(error.message)));
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new PlexRequestError(`Plex request failed with HTTP ${response.statusCode ?? 0}.`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch {
          reject(new PlexRequestError("Plex returned an unreadable response."));
        }
      });
    };
    const request = target.url.protocol === "https:"
      ? httpsRequest({ ...options, servername: target.url.hostname }, handleResponse)
      : httpRequest(options, handleResponse);
    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(new PlexRequestError(`Plex request timed out after ${requestTimeoutMs} ms.`));
    });
    request.on("error", (error) => reject(error instanceof PlexRequestError
      ? error
      : new PlexRequestError(error.message)));
    request.end();
  });
}

function classifyAddress(address: string) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return classifyAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const first = octets[0] ?? 0;
    const second = octets[1] ?? 0;
    const unsafe = first === 0 || (first === 169 && second === 254) || first >= 224;
    const local = first === 10
      || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 100 && second >= 64 && second <= 127);
    return { unsafe, local };
  }
  const unsafe = normalized === "::" || normalized.startsWith("fe8") || normalized.startsWith("fe9")
    || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff");
  const local = normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
  return { unsafe, local };
}

async function validateServerTarget(serverUrl: string): Promise<ValidatedTarget> {
  const networkMode = String(readSettings().networkMode);
  if (networkMode === "offline") {
    throw new PlexConfigurationError("Network mode is offline. Enable local network access before contacting Plex.");
  }
  const hostname = new URL(serverUrl).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
      throw new PlexRequestError("The Plex server hostname could not be resolved.");
    });
  if (!addresses.length) throw new PlexRequestError("The Plex server hostname did not resolve to an address.");
  const classifications = addresses.map(({ address }) => classifyAddress(address));
  if (classifications.some(({ unsafe }) => unsafe)) {
    throw new PlexConfigurationError("The Plex server resolved to a blocked link-local, multicast, or unspecified address.");
  }
  if (networkMode === "local_only" && classifications.some(({ local }) => !local)) {
    throw new PlexConfigurationError("Network mode only permits Plex servers on local or private addresses.");
  }
  const selected = addresses[0];
  if (!selected) throw new PlexRequestError("The Plex server hostname did not resolve to an address.");
  return {
    url: new URL(serverUrl),
    address: selected.address,
    family: isIP(selected.address) as 4 | 6,
  };
}

async function readLibraries(target: ValidatedTarget, token: string) {
  const payload = containerFrom(await requestJson(target, token, "/library/sections"));
  return asArray(payload.Directory)
    .map((library) => ({
      key: text(library.key),
      name: text(library.title) ?? "Untitled library",
      type: text(library.type) ?? "unknown",
    }))
    .filter((library): library is { key: string; name: string; type: string } => Boolean(library.key));
}

async function readPagedItems(target: ValidatedTarget, token: string, path: string) {
  const items: PlexRecord[] = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const payload = containerFrom(await requestJson(
      target,
      token,
      `${path}${path.includes("?") ? "&" : "?"}includeGuids=1&X-Plex-Container-Start=${offset}&X-Plex-Container-Size=${pageSize}`,
    ));
    const page = asArray(payload.Metadata);
    items.push(...page);
    const total = number(payload.totalSize);
    if (total !== null) {
      if (items.length >= total) break;
      if (!page.length) throw new PlexRequestError("Plex pagination stopped before all library items were returned.");
    } else if (!page.length || page.length < pageSize) {
      break;
    }
    offset += page.length;
  }
  return items;
}

async function readLibraryItems(target: ValidatedTarget, token: string, libraryKey: string) {
  return readPagedItems(target, token, `/library/sections/${encodeURIComponent(libraryKey)}/all`);
}

async function readShowEpisodes(target: ValidatedTarget, token: string, ratingKey: string) {
  return readPagedItems(target, token, `/library/metadata/${encodeURIComponent(ratingKey)}/allLeaves`);
}

function mapItem(item: PlexRecord) {
  const ratingKey = text(item.ratingKey);
  if (!ratingKey) return null;
  const media = asArray(item.Media).map((mediaRecord) => ({
    videoResolution: text(mediaRecord.videoResolution),
    videoCodec: text(mediaRecord.videoCodec),
    audioCodec: text(mediaRecord.audioCodec),
    bitrate: number(mediaRecord.bitrate),
    durationMs: number(mediaRecord.duration),
    parts: asArray(mediaRecord.Part).map((part) => ({
      filePath: text(part.file),
      sizeBytes: number(part.size),
      checksum: text(part.hash),
    })).filter((part): part is { filePath: string; sizeBytes: number | null; checksum: string | null } => Boolean(part.filePath)),
  }));
  return {
    ratingKey,
    title: text(item.title) ?? "Untitled Plex item",
    itemType: text(item.type) ?? "unknown",
    year: number(item.year),
    thumbUrl: text(item.thumb),
    addedAt: number(item.addedAt) ? new Date(Number(item.addedAt) * 1000).toISOString() : null,
    metadata: item,
    media,
  };
}

type PlexHierarchyCache = {
  showIds: Map<string, number>;
  seasonIds: Map<string, number>;
};

function persistPlexHierarchy(
  ownerId: string,
  itemId: number,
  item: NonNullable<ReturnType<typeof mapItem>>,
  cache: PlexHierarchyCache,
) {
  const metadata = asRecord(item.metadata);
  if (item.itemType === "show") {
    archiveDb.prepare("DELETE FROM plex_episode WHERE item_id = ?").run(itemId);
    archiveDb.prepare(`
      INSERT INTO plex_show (item_id, owner_id, rating_key, title, year, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(item_id) DO UPDATE SET
        owner_id = excluded.owner_id,
        rating_key = excluded.rating_key,
        title = excluded.title,
        year = excluded.year,
        updated_at = CURRENT_TIMESTAMP
    `).run(itemId, ownerId, item.ratingKey, item.title, item.year);
    cache.showIds.set(item.ratingKey, itemId);
    return;
  }
  if (item.itemType !== "episode") return;

  const grandparentRatingKey = text(metadata.grandparentRatingKey);
  const parentRatingKey = text(metadata.parentRatingKey);
  const seasonNumber = number(metadata.parentIndex);
  const episodeNumber = number(metadata.index);
  if (!grandparentRatingKey || seasonNumber === null) return;
  archiveDb.prepare("DELETE FROM plex_show WHERE item_id = ?").run(itemId);
  let showId = cache.showIds.get(grandparentRatingKey);
  if (showId === undefined) {
    const show = archiveDb.prepare(
      "SELECT id FROM plex_show WHERE owner_id = ? AND rating_key = ?",
    ).get(ownerId, grandparentRatingKey) as { id: number } | undefined;
    if (!show) return;
    showId = show.id;
    cache.showIds.set(grandparentRatingKey, showId);
  }
  const seasonKey = `${showId}:${seasonNumber}`;
  let seasonId = cache.seasonIds.get(seasonKey);
  archiveDb.prepare(`
    INSERT INTO plex_season (show_id, rating_key, season_number, title, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(show_id, season_number) DO UPDATE SET
      rating_key = excluded.rating_key,
      title = excluded.title,
      updated_at = CURRENT_TIMESTAMP
  `).run(showId, parentRatingKey, seasonNumber, text(metadata.parentTitle));
  if (seasonId === undefined) {
    const season = archiveDb.prepare(
      "SELECT id FROM plex_season WHERE show_id = ? AND season_number = ?",
    ).get(showId, seasonNumber) as { id: number };
    seasonId = season.id;
    cache.seasonIds.set(seasonKey, seasonId);
  }
  archiveDb.prepare(`
    INSERT INTO plex_episode (item_id, season_id, owner_id, rating_key, episode_number, title, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(item_id) DO UPDATE SET
      season_id = excluded.season_id,
      owner_id = excluded.owner_id,
      rating_key = excluded.rating_key,
      episode_number = excluded.episode_number,
      title = excluded.title,
      updated_at = CURRENT_TIMESTAMP
  `).run(itemId, seasonId, ownerId, item.ratingKey, episodeNumber, item.title);
}

function writeState(ownerId: string, updates: Record<string, unknown>) {
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) writeUserSetting(ownerId, key, value);
  }
}

function readState(ownerId: string, key: string) {
  const value = readUserSetting(ownerId, key);
  return typeof value === "string" ? value : null;
}

function readInventoryStats(ownerId: string, serverUrl: string) {
  return archiveDb.prepare(`
    SELECT
      COUNT(DISTINCT l.id) AS library_count,
      COUNT(DISTINCT i.id) AS item_count,
      COUNT(DISTINCT m.id) AS media_count
    FROM plex_library l
    LEFT JOIN plex_item i ON i.library_id = l.id AND i.owner_id = l.owner_id
    LEFT JOIN plex_media m ON m.item_id = i.id
    WHERE l.owner_id = ? AND l.server_url = ?
  `).get(ownerId, serverUrl) as { library_count: number; item_count: number; media_count: number };
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function mapItemsInBatches(items: PlexRecord[]) {
  const mapped: ReturnType<typeof mapItem>[] = [];
  for (let start = 0; start < items.length; start += plexPersistenceBatchSize) {
    mapped.push(...items.slice(start, start + plexPersistenceBatchSize).map(mapItem));
    await yieldToEventLoop();
  }
  return mapped;
}

async function stageLibraryRatingKeys(ownerId: string, libraryId: number, ratingKeys: string[]) {
  archiveDb.exec(`
    CREATE TEMP TABLE IF NOT EXISTS plex_sync_keys (
      owner_id TEXT NOT NULL,
      library_id INTEGER NOT NULL,
      rating_key TEXT NOT NULL,
      PRIMARY KEY (owner_id, library_id, rating_key)
    )
  `);
  archiveDb.prepare(
    "DELETE FROM plex_sync_keys WHERE owner_id = ? AND library_id = ?",
  ).run(ownerId, libraryId);
  for (let start = 0; start < ratingKeys.length; start += plexPersistenceBatchSize) {
    archiveDb.exec("BEGIN IMMEDIATE");
    try {
      for (const ratingKey of ratingKeys.slice(start, start + plexPersistenceBatchSize)) {
        archiveDb.prepare(
          "INSERT OR IGNORE INTO plex_sync_keys (owner_id, library_id, rating_key) VALUES (?, ?, ?)",
        ).run(ownerId, libraryId, ratingKey);
      }
      archiveDb.exec("COMMIT");
    } catch (error) {
      archiveDb.exec("ROLLBACK");
      throw error;
    }
    await yieldToEventLoop();
  }
}

async function deleteStaleLibraryItems(ownerId: string, libraryId: number) {
  while (true) {
    const staleRows = archiveDb.prepare(
      `SELECT id
       FROM plex_item
       WHERE owner_id = ? AND library_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM plex_sync_keys
           WHERE owner_id = plex_item.owner_id
             AND library_id = plex_item.library_id
             AND rating_key = plex_item.rating_key
         )
       LIMIT ?`,
    ).all(ownerId, libraryId, plexPersistenceBatchSize) as Array<{ id: number }>;
    if (!staleRows.length) return;
    const placeholders = staleRows.map(() => "?").join(", ");
    archiveDb.prepare(
      `DELETE FROM plex_item
       WHERE owner_id = ? AND library_id = ? AND id IN (${placeholders})`,
    ).run(ownerId, libraryId, ...staleRows.map((row) => row.id));
    await yieldToEventLoop();
  }
}

export function getPlexConfig(ownerId: string) {
  const { serverUrl, token } = readPlexCredentials(ownerId);
  const configured = Boolean(serverUrl && token);
  const syncStatus = readState(ownerId, "plexSyncStatus");
  const connectionStatus = readState(ownerId, "plexConnectionStatus");
  const status: PlexState = !configured
    ? "not_configured"
    : syncStatus === "syncing"
      ? "syncing"
      : connectionStatus === "connection_failed"
        ? "connection_failed"
        : syncStatus === "sync_error"
          ? "sync_error"
          : syncStatus === "synced"
            ? "synced"
            : connectionStatus === "connected"
              ? "connected"
              : "configured";
  const exposedConnectionStatus = !configured
    ? "not_configured"
    : connectionStatus === "connection_failed"
      ? "connection_failed"
      : connectionStatus === "connected"
        ? "connected"
        : "configured";
  const exposedSyncStatus = syncStatus === "syncing"
    ? "syncing"
    : syncStatus === "sync_error"
      ? "sync_error"
      : syncStatus === "synced"
        ? "synced"
        : "idle";
  const stats = configured ? readInventoryStats(ownerId, serverUrl) : { library_count: 0, item_count: 0, media_count: 0 };
  return {
    serverUrl,
    configured,
    hasToken: Boolean(token),
    status,
    connectionStatus: exposedConnectionStatus,
    syncStatus: exposedSyncStatus,
    lastAttemptedAt: readState(ownerId, "plexLastAttemptedAt"),
    lastSuccessfulSyncAt: readState(ownerId, "plexLastSuccessfulSyncAt"),
    lastError: readState(ownerId, "plexLastError"),
    serverName: readState(ownerId, "plexServerName"),
    libraryCount: Number(stats.library_count ?? 0),
    itemCount: Number(stats.item_count ?? 0),
    mediaCount: Number(stats.media_count ?? 0),
  };
}

export function savePlexConfig(ownerId: string, updates: { serverUrl?: string; token?: string }) {
  if (updates.serverUrl !== undefined) {
    const serverUrl = normalizeServerUrl(updates.serverUrl);
    writeUserSetting(ownerId, "plexServerUrl", serverUrl);
    writeState(ownerId, {
      plexConnectionStatus: "configured",
      plexSyncStatus: "idle",
      plexLastError: null,
    });
  }
  if (updates.token !== undefined && updates.token.trim()) {
    writeUserSetting(ownerId, "plexToken", updates.token.trim());
    writeState(ownerId, {
      plexConnectionStatus: "configured",
      plexSyncStatus: "idle",
      plexLastError: null,
    });
  }
  return getPlexConfig(ownerId);
}

export async function testPlexConnection(ownerId: string) {
  const { serverUrl, token } = readPlexCredentials(ownerId);
  if (!serverUrl || !token) {
    writeState(ownerId, { plexConnectionStatus: "connection_failed", plexLastError: "Plex server URL and token are required." });
    return getPlexConfig(ownerId);
  }
  try {
    const target = await validateServerTarget(serverUrl);
    const payload = containerFrom(await requestJson(target, token, "/identity"));
    const serverName = text(payload.friendlyName) ?? text(payload.name) ?? text(payload.machineIdentifier);
    writeState(ownerId, {
      plexConnectionStatus: "connected",
      plexServerName: serverName,
      plexLastError: null,
    });
    addEvent("success", `Plex connection verified${serverName ? `: ${serverName}` : ""}`, "plex", ownerId);
  } catch (error) {
    const message = publicError(error);
    writeState(ownerId, { plexConnectionStatus: "connection_failed", plexLastError: message });
    addEvent("error", `Plex connection failed: ${message}`, "plex", ownerId);
  }
  return getPlexConfig(ownerId);
}

async function persistLibrary(
  ownerId: string,
  serverUrl: string,
  library: { key: string; name: string; type: string; complete: boolean },
  items: ReturnType<typeof mapItem>[],
) {
    const existing = archiveDb.prepare(
      "SELECT id FROM plex_library WHERE owner_id = ? AND server_url = ? AND library_key = ?",
    ).get(ownerId, serverUrl, library.key) as { id: number } | undefined;
    let libraryId: number;
    if (existing) {
      libraryId = Number(existing.id);
      archiveDb.prepare(`
        UPDATE plex_library
        SET name = ?, library_type = ?, sync_status = 'syncing', sync_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND owner_id = ?
      `).run(library.name, library.type, libraryId, ownerId);
    } else {
      const result = archiveDb.prepare(`
        INSERT INTO plex_library
          (name, server_url, library_key, library_type, owner_id, sync_status)
        VALUES (?, ?, ?, ?, ?, 'syncing')
      `).run(library.name, serverUrl, library.key, library.type, ownerId);
      libraryId = Number(result.lastInsertRowid);
    }

    const ratingKeys: string[] = [];
    for (const item of items) {
      if (item) ratingKeys.push(item.ratingKey);
    }
    for (let start = 0; start < items.length; start += plexPersistenceBatchSize) {
      archiveDb.exec("BEGIN IMMEDIATE");
      try {
        const hierarchyCache: PlexHierarchyCache = {
          showIds: new Map(),
          seasonIds: new Map(),
        };
        for (const item of items.slice(start, start + plexPersistenceBatchSize)) {
          if (!item) continue;
          archiveDb.prepare(`
            INSERT INTO plex_item
              (library_id, rating_key, title, item_type, year, metadata_json, owner_id, thumb_url, added_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(owner_id, rating_key) DO UPDATE SET
              library_id = excluded.library_id,
              title = excluded.title,
              item_type = excluded.item_type,
              year = excluded.year,
              metadata_json = excluded.metadata_json,
              thumb_url = excluded.thumb_url,
              added_at = excluded.added_at,
              updated_at = CURRENT_TIMESTAMP
          `).run(
            libraryId,
            item.ratingKey,
            item.title,
            item.itemType,
            item.year,
            JSON.stringify(item.metadata),
            ownerId,
            item.thumbUrl,
            item.addedAt,
          );
          const itemRow = archiveDb.prepare(
            "SELECT id FROM plex_item WHERE owner_id = ? AND rating_key = ?",
          ).get(ownerId, item.ratingKey) as { id: number };
          const itemId = Number(itemRow.id);
          persistPlexHierarchy(ownerId, itemId, item, hierarchyCache);
          archiveDb.prepare(
            "DELETE FROM plex_part WHERE media_id IN (SELECT id FROM plex_media WHERE item_id = ?)",
          ).run(itemId);
          archiveDb.prepare("DELETE FROM plex_media WHERE item_id = ?").run(itemId);
          for (const media of item.media) {
            const mediaResult = archiveDb.prepare(`
              INSERT INTO plex_media
                (item_id, video_resolution, video_codec, audio_codec, bitrate, duration_ms)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(itemId, media.videoResolution, media.videoCodec, media.audioCodec, media.bitrate, media.durationMs);
            const mediaId = Number(mediaResult.lastInsertRowid);
            for (const part of media.parts) {
              archiveDb.prepare(
                "INSERT INTO plex_part (media_id, file_path, size_bytes, checksum) VALUES (?, ?, ?, ?)",
              ).run(mediaId, part.filePath, part.sizeBytes, part.checksum);
            }
          }
        }
        archiveDb.exec("COMMIT");
      } catch (error) {
        archiveDb.exec("ROLLBACK");
        throw error;
      }
      await yieldToEventLoop();
    }

    if (library.complete) {
      await stageLibraryRatingKeys(ownerId, libraryId, ratingKeys);
      await deleteStaleLibraryItems(ownerId, libraryId);
    }
    const itemCount = archiveDb.prepare(
      "SELECT COUNT(*) AS count FROM plex_item WHERE owner_id = ? AND library_id = ?",
    ).get(ownerId, libraryId) as { count: number };
    archiveDb.prepare(`
      UPDATE plex_library
      SET item_count = ?, last_synced_at = CURRENT_TIMESTAMP, sync_status = 'synced',
          sync_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_id = ?
    `).run(Number(itemCount.count), libraryId, ownerId);
}

async function reconcileInventory(ownerId: string, serverUrl: string, libraries: Array<{
  key: string;
  name: string;
  type: string;
  complete: boolean;
  items: ReturnType<typeof mapItem>[];
}>) {
  for (const library of libraries) {
    await persistLibrary(ownerId, serverUrl, library, library.items);
    invalidateArchiveInventoryCache(ownerId);
    await yieldToEventLoop();
  }
  archiveDb.exec("BEGIN IMMEDIATE");
  try {
    const currentLibraryKeys = new Set(libraries.map((library) => library.key));
    const existingLibraries = archiveDb.prepare(
      "SELECT id, library_key FROM plex_library WHERE owner_id = ? AND server_url = ?",
    ).all(ownerId, serverUrl) as Array<{ id: number; library_key: string }>;
    for (const library of existingLibraries) {
      if (!currentLibraryKeys.has(library.library_key)) {
        archiveDb.prepare(
          "DELETE FROM plex_library WHERE owner_id = ? AND server_url = ? AND id = ?",
        ).run(ownerId, serverUrl, library.id);
      }
    }
    archiveDb.exec("COMMIT");
    invalidateArchiveInventoryCache(ownerId);
  } catch (error) {
    archiveDb.exec("ROLLBACK");
    throw error;
  }
}

export async function syncPlexInventory(ownerId: string) {
  const { serverUrl, token } = readPlexCredentials(ownerId);
  if (!serverUrl || !token) throw new PlexConfigurationError("Configure a Plex server URL and token before syncing.");
  writeState(ownerId, {
    plexSyncStatus: "syncing",
    plexLastAttemptedAt: new Date().toISOString(),
    plexLastError: null,
  });
  try {
    const target = await validateServerTarget(serverUrl);
    const identity = containerFrom(await requestJson(target, token, "/identity"));
    const serverName = text(identity.friendlyName) ?? text(identity.name) ?? text(identity.machineIdentifier);
    if (serverName) writeUserSetting(ownerId, "plexServerName", serverName);
    writeState(ownerId, { plexConnectionStatus: "connected" });
    const libraries = await readLibraries(target, token);
    const remoteInventory: Array<{
      key: string;
      name: string;
      type: string;
      complete: boolean;
      items: ReturnType<typeof mapItem>[];
    }> = [];
    const warnings: string[] = [];
    for (const library of libraries) {
      const rawItems = await readLibraryItems(target, token, library.key);
      let complete = true;
      if (library.type === "show") {
        const episodeItems: PlexRecord[] = [];
        for (const show of rawItems) {
          const ratingKey = text(show.ratingKey);
          if (!ratingKey) continue;
          try {
            episodeItems.push(...await readShowEpisodes(target, token, ratingKey));
          } catch (error) {
            complete = false;
            warnings.push(`Plex episode sync skipped "${text(show.title) ?? ratingKey}": ${publicError(error)}`);
          }
        }
        const combinedItems = [...rawItems, ...episodeItems];
        remoteInventory.push({ ...library, complete, items: await mapItemsInBatches(combinedItems) });
        continue;
      }
      remoteInventory.push({ ...library, complete, items: await mapItemsInBatches(rawItems) });
    }
    await reconcileInventory(ownerId, serverUrl, remoteInventory);
    const successfulAt = new Date().toISOString();
    writeState(ownerId, {
      plexSyncStatus: "synced",
      plexLastSuccessfulSyncAt: successfulAt,
      plexLastError: null,
    });
    for (const warning of warnings) addEvent("warning", warning, "plex", ownerId);
    addEvent("success", `Plex inventory synchronized: ${libraries.length} libraries`, "plex", ownerId);
  } catch (error) {
    const message = publicError(error);
    writeState(ownerId, { plexSyncStatus: "sync_error", plexLastError: message });
    addEvent("error", `Plex inventory sync failed: ${message}`, "plex", ownerId);
  }
}

export function startPlexSync(ownerId: string) {
  const config = getPlexConfig(ownerId);
  if (!config.configured) throw new PlexConfigurationError("Configure a Plex server URL and token before syncing.");
  if (syncs.has(ownerId)) throw new PlexConfigurationError("A Plex synchronization is already running.");
  const operation = syncPlexInventory(ownerId).finally(() => syncs.delete(ownerId));
  syncs.set(ownerId, operation);
  return getPlexConfig(ownerId);
}

export function readPlexInventory(ownerId: string) {
  const { serverUrl } = readPlexCredentials(ownerId);
  const libraries = archiveDb.prepare(`
    SELECT id, library_key, name, library_type, server_url, item_count, last_synced_at, sync_status, sync_error
    FROM plex_library
    WHERE owner_id = ? AND server_url = ?
    ORDER BY name COLLATE NOCASE
  `).all(ownerId, serverUrl) as Array<Record<string, unknown>>;
  const items = archiveDb.prepare(`
    SELECT
      i.id, i.library_id, l.name AS library_name, i.rating_key, i.title, i.item_type,
      i.year, i.thumb_url, i.added_at, i.updated_at,
      COUNT(DISTINCT m.id) AS media_count, COUNT(p.id) AS part_count
    FROM plex_item i
    JOIN plex_library l ON l.id = i.library_id AND l.owner_id = i.owner_id
    LEFT JOIN plex_media m ON m.item_id = i.id
    LEFT JOIN plex_part p ON p.media_id = m.id
    WHERE i.owner_id = ? AND l.server_url = ?
    GROUP BY i.id
    ORDER BY i.title COLLATE NOCASE
  `).all(ownerId, serverUrl) as Array<Record<string, unknown>>;
  return {
    libraries: libraries.map((library) => ({
      id: Number(library.id),
      key: String(library.library_key),
      name: String(library.name),
      type: String(library.library_type),
      serverUrl: String(library.server_url),
      itemCount: Number(library.item_count ?? 0),
      lastSyncedAt: (library.last_synced_at as string | null) ?? null,
      syncStatus: String(library.sync_status),
      syncError: (library.sync_error as string | null) ?? null,
    })),
    items: items.map((item) => ({
      id: Number(item.id),
      libraryId: Number(item.library_id),
      libraryName: String(item.library_name),
      ratingKey: String(item.rating_key),
      title: String(item.title),
      itemType: String(item.item_type),
      year: item.year == null ? null : Number(item.year),
      thumbPathAvailable: Boolean(item.thumb_url),
      addedAt: (item.added_at as string | null) ?? null,
      updatedAt: (item.updated_at as string | null) ?? null,
      mediaCount: Number(item.media_count ?? 0),
      partCount: Number(item.part_count ?? 0),
    })),
  };
}

// A process-local sync cannot continue after the local API restarts. Convert
// persisted in-flight markers into an explicit error instead of claiming that
// synchronization is still running forever.
const interruptedSyncs = archiveDb.prepare(
  "SELECT owner_id FROM user_setting WHERE key = 'plexSyncStatus' AND value = '\"syncing\"'",
).all() as Array<{ owner_id: string }>;
for (const row of interruptedSyncs) {
  writeState(row.owner_id, {
    plexSyncStatus: "sync_error",
    plexLastError: "Plex synchronization was interrupted by an application restart.",
  });
  addEvent("warning", "Plex synchronization was interrupted by an application restart.", "plex", row.owner_id);
}