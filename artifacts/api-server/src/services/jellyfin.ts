import {
  archiveDb,
  addEvent,
  readSettings,
  readUserSetting,
  writeUserSetting,
} from "../lib/archive-db";
import {
  normalizeServerUrl as normalizeUrl,
  requestJson as requestProviderJson,
  validateServerTarget as validateTarget,
  type ValidatedTarget,
} from "../lib/network-target";
import { invalidateArchiveInventoryCache } from "./archive";

const jellyfinPersistenceBatchSize = 100;
const itemPageSize = 500;
const syncs = new Map<string, Promise<void>>();

type JellyfinRecord = Record<string, unknown>;

export type JellyfinState =
  | "not_configured"
  | "configured"
  | "connection_failed"
  | "connected"
  | "syncing"
  | "synced"
  | "sync_error";

export class JellyfinConfigurationError extends Error {}

class JellyfinRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JellyfinRequestError";
  }
}

const errorFactories = {
  configurationError: (message: string) => new JellyfinConfigurationError(message),
  requestError: (message: string) => new JellyfinRequestError(message),
};

function asRecord(value: unknown): JellyfinRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JellyfinRecord : {};
}

function asArray(value: unknown): JellyfinRecord[] {
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
  return normalizeUrl(value, "Jellyfin", errorFactories.configurationError);
}

function readJellyfinCredentials(ownerId: string) {
  const serverUrl = normalizeServerUrl(readUserSetting(ownerId, "jellyfinServerUrl"));
  const apiKey = readUserSetting(ownerId, "jellyfinApiKey");
  const userId = readUserSetting(ownerId, "jellyfinUserId");
  return {
    serverUrl,
    apiKey: typeof apiKey === "string" ? apiKey.trim() : "",
    userId: typeof userId === "string" ? userId.trim() : "",
  };
}

function publicError(error: unknown) {
  if (error instanceof JellyfinConfigurationError || error instanceof JellyfinRequestError) {
    return error.message;
  }
  return "Jellyfin synchronization failed unexpectedly. Check the local API event log.";
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

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function validateServerTarget(serverUrl: string) {
  return validateTarget(serverUrl, {
    label: "Jellyfin",
    networkMode: String(readSettings().networkMode),
    ...errorFactories,
  });
}

// Jellyfin authenticates with a static API token supplied by the operator. The
// token travels in the Authorization header rather than the query string so it
// is not captured by intermediate access logs.
function requestJson(target: ValidatedTarget, apiKey: string, path: string) {
  return requestProviderJson({
    target,
    path,
    label: "Jellyfin",
    requestError: errorFactories.requestError,
    headers: {
      Authorization: `MediaBrowser Token="${apiKey}", Client="Archive Assistant", Device="Archive Assistant", DeviceId="archive-assistant", Version="1.0.0"`,
    },
  });
}

async function readSystemInfo(target: ValidatedTarget, apiKey: string) {
  return asRecord(await requestJson(target, apiKey, "/System/Info"));
}

/**
 * Resolve the user whose library view should be synchronized. Jellyfin scopes
 * item queries per user, so an explicit configured user wins and otherwise the
 * first returned account is used.
 */
async function resolveUserId(target: ValidatedTarget, apiKey: string, configuredUserId: string) {
  if (configuredUserId) return configuredUserId;
  const users = asArray(await requestJson(target, apiKey, "/Users"));
  const firstUser = users.map((user) => text(user.Id)).find((id): id is string => Boolean(id));
  if (!firstUser) {
    throw new JellyfinRequestError("Jellyfin did not return any user accounts to synchronize.");
  }
  return firstUser;
}

async function readLibraries(target: ValidatedTarget, apiKey: string, userId: string) {
  const payload = asRecord(
    await requestJson(target, apiKey, `/Users/${encodeURIComponent(userId)}/Views`),
  );
  return asArray(payload.Items)
    .map((library) => ({
      key: text(library.Id),
      name: text(library.Name) ?? "Untitled library",
      type: text(library.CollectionType) ?? "unknown",
    }))
    .filter((library): library is { key: string; name: string; type: string } =>
      Boolean(library.key));
}

/**
 * Page through a library's items, following Jellyfin's declared
 * TotalRecordCount rather than assuming the requested page size is honored.
 */
async function readLibraryItems(
  target: ValidatedTarget,
  apiKey: string,
  userId: string,
  libraryKey: string,
) {
  const items: JellyfinRecord[] = [];
  let startIndex = 0;
  while (true) {
    const payload = asRecord(await requestJson(
      target,
      apiKey,
      `/Users/${encodeURIComponent(userId)}/Items`
      + `?ParentId=${encodeURIComponent(libraryKey)}`
      + "&Recursive=true"
      + "&IncludeItemTypes=Movie,Episode"
      + "&Fields=Path,MediaSources,MediaStreams,ProductionYear,DateCreated,ParentIndexNumber,IndexNumber,SeriesName"
      + `&StartIndex=${startIndex}&Limit=${itemPageSize}`,
    ));
    const page = asArray(payload.Items);
    items.push(...page);
    const total = number(payload.TotalRecordCount);
    if (total !== null) {
      if (items.length >= total) break;
      if (!page.length) {
        throw new JellyfinRequestError(
          "Jellyfin pagination stopped before all library items were returned.",
        );
      }
    } else if (!page.length || page.length < itemPageSize) {
      break;
    }
    startIndex += page.length;
  }
  return items;
}

function resolutionLabel(width: unknown, height: unknown) {
  const numericHeight = number(height);
  if (numericHeight) return String(numericHeight);
  const numericWidth = number(width);
  // Fall back to a conventional height when only width is reported.
  if (numericWidth && numericWidth >= 3000) return "2160";
  if (numericWidth && numericWidth >= 1900) return "1080";
  if (numericWidth && numericWidth >= 1200) return "720";
  return null;
}

function mapItem(item: JellyfinRecord) {
  const itemKey = text(item.Id);
  if (!itemKey) return null;
  const mediaSources = asArray(item.MediaSources);
  const media = mediaSources.map((source) => {
    const streams = asArray(source.MediaStreams);
    const videoStream = streams.find((stream) => text(stream.Type) === "Video") ?? {};
    const audioStream = streams.find((stream) => text(stream.Type) === "Audio") ?? {};
    const runTimeTicks = number(source.RunTimeTicks) ?? number(item.RunTimeTicks);
    const filePath = text(source.Path) ?? text(item.Path);
    return {
      videoResolution: resolutionLabel(videoStream.Width, videoStream.Height),
      videoCodec: text(videoStream.Codec),
      audioCodec: text(audioStream.Codec),
      bitrate: number(source.Bitrate) ?? number(videoStream.BitRate),
      // Jellyfin reports duration in 100-nanosecond ticks.
      durationMs: runTimeTicks === null ? null : Math.round(runTimeTicks / 10_000),
      audioChannels: number(audioStream.Channels),
      container: text(source.Container),
      dynamicRange: text(videoStream.VideoRange),
      parts: filePath
        ? [{
          filePath,
          sizeBytes: number(source.Size),
          checksum: null as string | null,
        }]
        : [],
    };
  });
  const itemType = text(item.Type) === "Episode" ? "episode" : "movie";
  const dateCreated = text(item.DateCreated);
  const primaryMedia = media[0];
  return {
    itemKey,
    title: text(item.Name) ?? "Untitled Jellyfin item",
    itemType,
    year: number(item.ProductionYear),
    thumbUrl: text(item.PrimaryImageTag),
    addedAt: dateCreated && Number.isFinite(Date.parse(dateCreated))
      ? new Date(dateCreated).toISOString()
      : null,
    // Persist the shape the archive comparison reads, keeping the raw payload
    // available for later inspection without re-fetching.
    metadata: {
      ...item,
      dynamicRange: primaryMedia?.dynamicRange ?? null,
      media: {
        audioChannels: primaryMedia?.audioChannels ?? null,
        container: primaryMedia?.container ?? null,
      },
      seriesName: text(item.SeriesName),
      seasonNumber: number(item.ParentIndexNumber),
      episodeNumber: number(item.IndexNumber),
    },
    media,
  };
}

async function mapItemsInBatches(items: JellyfinRecord[]) {
  const mapped: ReturnType<typeof mapItem>[] = [];
  for (let start = 0; start < items.length; start += jellyfinPersistenceBatchSize) {
    mapped.push(...items.slice(start, start + jellyfinPersistenceBatchSize).map(mapItem));
    await yieldToEventLoop();
  }
  return mapped;
}

async function stageLibraryItemKeys(ownerId: string, libraryId: number, itemKeys: string[]) {
  archiveDb.exec(`
    CREATE TEMP TABLE IF NOT EXISTS jellyfin_sync_keys (
      owner_id TEXT NOT NULL,
      library_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      PRIMARY KEY (owner_id, library_id, item_key)
    )
  `);
  archiveDb.prepare(
    "DELETE FROM jellyfin_sync_keys WHERE owner_id = ? AND library_id = ?",
  ).run(ownerId, libraryId);
  for (let start = 0; start < itemKeys.length; start += jellyfinPersistenceBatchSize) {
    archiveDb.exec("BEGIN IMMEDIATE");
    try {
      for (const itemKey of itemKeys.slice(start, start + jellyfinPersistenceBatchSize)) {
        archiveDb.prepare(
          "INSERT OR IGNORE INTO jellyfin_sync_keys (owner_id, library_id, item_key) VALUES (?, ?, ?)",
        ).run(ownerId, libraryId, itemKey);
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
       FROM jellyfin_item
       WHERE owner_id = ? AND library_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM jellyfin_sync_keys
           WHERE owner_id = jellyfin_item.owner_id
             AND library_id = jellyfin_item.library_id
             AND item_key = jellyfin_item.item_key
         )
       LIMIT ?`,
    ).all(ownerId, libraryId, jellyfinPersistenceBatchSize) as Array<{ id: number }>;
    if (!staleRows.length) return;
    const placeholders = staleRows.map(() => "?").join(", ");
    archiveDb.prepare(
      `DELETE FROM jellyfin_item
       WHERE owner_id = ? AND library_id = ? AND id IN (${placeholders})`,
    ).run(ownerId, libraryId, ...staleRows.map((row) => row.id));
    await yieldToEventLoop();
  }
}

async function persistLibrary(
  ownerId: string,
  serverUrl: string,
  library: { key: string; name: string; type: string; complete: boolean },
  items: ReturnType<typeof mapItem>[],
) {
  const existing = archiveDb.prepare(
    "SELECT id FROM jellyfin_library WHERE owner_id = ? AND server_url = ? AND library_key = ?",
  ).get(ownerId, serverUrl, library.key) as { id: number } | undefined;
  let libraryId: number;
  if (existing) {
    libraryId = Number(existing.id);
    archiveDb.prepare(`
      UPDATE jellyfin_library
      SET name = ?, library_type = ?, sync_status = 'syncing', sync_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_id = ?
    `).run(library.name, library.type, libraryId, ownerId);
  } else {
    const result = archiveDb.prepare(`
      INSERT INTO jellyfin_library
        (name, server_url, library_key, library_type, owner_id, sync_status)
      VALUES (?, ?, ?, ?, ?, 'syncing')
    `).run(library.name, serverUrl, library.key, library.type, ownerId);
    libraryId = Number(result.lastInsertRowid);
  }

  const itemKeys: string[] = [];
  for (const item of items) {
    if (item) itemKeys.push(item.itemKey);
  }

  for (let start = 0; start < items.length; start += jellyfinPersistenceBatchSize) {
    archiveDb.exec("BEGIN IMMEDIATE");
    try {
      for (const item of items.slice(start, start + jellyfinPersistenceBatchSize)) {
        if (!item) continue;
        archiveDb.prepare(`
          INSERT INTO jellyfin_item
            (library_id, item_key, title, item_type, year, metadata_json, owner_id,
             thumb_url, added_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(owner_id, item_key) DO UPDATE SET
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
          item.itemKey,
          item.title,
          item.itemType,
          item.year,
          JSON.stringify(item.metadata),
          ownerId,
          item.thumbUrl,
          item.addedAt,
        );
        // Resolve the canonical row by its owner-scoped unique key: after an
        // upsert takes the conflict path, lastInsertRowid can point elsewhere.
        const itemRow = archiveDb.prepare(
          "SELECT id FROM jellyfin_item WHERE owner_id = ? AND item_key = ?",
        ).get(ownerId, item.itemKey) as { id: number };
        const itemId = Number(itemRow.id);
        archiveDb.prepare(
          "DELETE FROM jellyfin_part WHERE media_id IN (SELECT id FROM jellyfin_media WHERE item_id = ?)",
        ).run(itemId);
        archiveDb.prepare("DELETE FROM jellyfin_media WHERE item_id = ?").run(itemId);
        for (const media of item.media) {
          const mediaResult = archiveDb.prepare(`
            INSERT INTO jellyfin_media
              (item_id, video_resolution, video_codec, audio_codec, bitrate, duration_ms)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            itemId,
            media.videoResolution,
            media.videoCodec,
            media.audioCodec,
            media.bitrate,
            media.durationMs,
          );
          const mediaId = Number(mediaResult.lastInsertRowid);
          for (const part of media.parts) {
            archiveDb.prepare(
              "INSERT INTO jellyfin_part (media_id, file_path, size_bytes, checksum) VALUES (?, ?, ?, ?)",
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

  // Only prune when the remote snapshot for this library was complete;
  // otherwise a partial fetch would delete still-present inventory.
  if (library.complete) {
    await stageLibraryItemKeys(ownerId, libraryId, itemKeys);
    await deleteStaleLibraryItems(ownerId, libraryId);
  }
  const itemCount = archiveDb.prepare(
    "SELECT COUNT(*) AS count FROM jellyfin_item WHERE owner_id = ? AND library_id = ?",
  ).get(ownerId, libraryId) as { count: number };
  archiveDb.prepare(`
    UPDATE jellyfin_library
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
      "SELECT id, library_key FROM jellyfin_library WHERE owner_id = ? AND server_url = ?",
    ).all(ownerId, serverUrl) as Array<{ id: number; library_key: string }>;
    for (const library of existingLibraries) {
      if (!currentLibraryKeys.has(library.library_key)) {
        archiveDb.prepare(
          "DELETE FROM jellyfin_library WHERE owner_id = ? AND server_url = ? AND id = ?",
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

function readInventoryStats(ownerId: string, serverUrl: string) {
  return archiveDb.prepare(`
    SELECT
      COUNT(DISTINCT l.id) AS library_count,
      COUNT(DISTINCT i.id) AS item_count,
      COUNT(DISTINCT m.id) AS media_count
    FROM jellyfin_library l
    LEFT JOIN jellyfin_item i ON i.library_id = l.id AND i.owner_id = l.owner_id
    LEFT JOIN jellyfin_media m ON m.item_id = i.id
    WHERE l.owner_id = ? AND l.server_url = ?
  `).get(ownerId, serverUrl) as {
    library_count: number;
    item_count: number;
    media_count: number;
  };
}

export function getJellyfinConfig(ownerId: string) {
  const { serverUrl, apiKey, userId } = readJellyfinCredentials(ownerId);
  const configured = Boolean(serverUrl && apiKey);
  const syncStatus = readState(ownerId, "jellyfinSyncStatus");
  const connectionStatus = readState(ownerId, "jellyfinConnectionStatus");
  const status: JellyfinState = !configured
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
  const stats = configured
    ? readInventoryStats(ownerId, serverUrl)
    : { library_count: 0, item_count: 0, media_count: 0 };
  return {
    serverUrl,
    configured,
    hasApiKey: Boolean(apiKey),
    userId: userId || null,
    status,
    connectionStatus: exposedConnectionStatus,
    syncStatus: exposedSyncStatus,
    lastAttemptedAt: readState(ownerId, "jellyfinLastAttemptedAt"),
    lastSuccessfulSyncAt: readState(ownerId, "jellyfinLastSuccessfulSyncAt"),
    lastError: readState(ownerId, "jellyfinLastError"),
    serverName: readState(ownerId, "jellyfinServerName"),
    libraryCount: Number(stats.library_count ?? 0),
    itemCount: Number(stats.item_count ?? 0),
    mediaCount: Number(stats.media_count ?? 0),
  };
}

export function saveJellyfinConfig(
  ownerId: string,
  updates: { serverUrl?: string; apiKey?: string; userId?: string },
) {
  if (updates.serverUrl !== undefined) {
    const serverUrl = normalizeServerUrl(updates.serverUrl);
    writeUserSetting(ownerId, "jellyfinServerUrl", serverUrl);
    writeState(ownerId, {
      jellyfinConnectionStatus: "configured",
      jellyfinSyncStatus: "idle",
      jellyfinLastError: null,
    });
  }
  if (updates.apiKey !== undefined && updates.apiKey.trim()) {
    writeUserSetting(ownerId, "jellyfinApiKey", updates.apiKey.trim());
    writeState(ownerId, {
      jellyfinConnectionStatus: "configured",
      jellyfinSyncStatus: "idle",
      jellyfinLastError: null,
    });
  }
  if (updates.userId !== undefined) {
    writeUserSetting(ownerId, "jellyfinUserId", updates.userId.trim());
  }
  return getJellyfinConfig(ownerId);
}

export async function testJellyfinConnection(ownerId: string) {
  const { serverUrl, apiKey } = readJellyfinCredentials(ownerId);
  if (!serverUrl || !apiKey) {
    writeState(ownerId, {
      jellyfinConnectionStatus: "connection_failed",
      jellyfinLastError: "Jellyfin server URL and API key are required.",
    });
    return getJellyfinConfig(ownerId);
  }
  try {
    const target = await validateServerTarget(serverUrl);
    const info = await readSystemInfo(target, apiKey);
    const serverName = text(info.ServerName) ?? text(info.Id);
    writeState(ownerId, {
      jellyfinConnectionStatus: "connected",
      jellyfinServerName: serverName,
      jellyfinLastError: null,
    });
    addEvent(
      "success",
      `Jellyfin connection verified${serverName ? `: ${serverName}` : ""}`,
      "jellyfin",
      ownerId,
    );
  } catch (error) {
    const message = publicError(error);
    writeState(ownerId, {
      jellyfinConnectionStatus: "connection_failed",
      jellyfinLastError: message,
    });
    addEvent("error", `Jellyfin connection failed: ${message}`, "jellyfin", ownerId);
  }
  return getJellyfinConfig(ownerId);
}

export async function syncJellyfinInventory(ownerId: string) {
  const { serverUrl, apiKey, userId: configuredUserId } = readJellyfinCredentials(ownerId);
  if (!serverUrl || !apiKey) {
    throw new JellyfinConfigurationError(
      "Configure a Jellyfin server URL and API key before syncing.",
    );
  }
  writeState(ownerId, {
    jellyfinSyncStatus: "syncing",
    jellyfinLastAttemptedAt: new Date().toISOString(),
    jellyfinLastError: null,
  });
  try {
    const target = await validateServerTarget(serverUrl);
    const info = await readSystemInfo(target, apiKey);
    const serverName = text(info.ServerName) ?? text(info.Id);
    if (serverName) writeUserSetting(ownerId, "jellyfinServerName", serverName);
    writeState(ownerId, { jellyfinConnectionStatus: "connected" });

    const userId = await resolveUserId(target, apiKey, configuredUserId);
    const libraries = await readLibraries(target, apiKey, userId);
    // Stage the complete remote snapshot before touching SQLite so a failure
    // partway through leaves the previous inventory intact.
    const remoteInventory: Array<{
      key: string;
      name: string;
      type: string;
      complete: boolean;
      items: ReturnType<typeof mapItem>[];
    }> = [];
    const warnings: string[] = [];
    for (const library of libraries) {
      try {
        const rawItems = await readLibraryItems(target, apiKey, userId, library.key);
        remoteInventory.push({
          ...library,
          complete: true,
          items: await mapItemsInBatches(rawItems),
        });
      } catch (error) {
        // Keep the library, but mark it incomplete so pruning is skipped.
        warnings.push(`Jellyfin library "${library.name}" was skipped: ${publicError(error)}`);
        remoteInventory.push({ ...library, complete: false, items: [] });
      }
    }
    await reconcileInventory(ownerId, serverUrl, remoteInventory);
    const successfulAt = new Date().toISOString();
    writeState(ownerId, {
      jellyfinSyncStatus: "synced",
      jellyfinLastSuccessfulSyncAt: successfulAt,
      jellyfinLastError: null,
    });
    for (const warning of warnings) addEvent("warning", warning, "jellyfin", ownerId);
    addEvent(
      "success",
      `Jellyfin inventory synchronized: ${libraries.length} libraries`,
      "jellyfin",
      ownerId,
    );
  } catch (error) {
    const message = publicError(error);
    writeState(ownerId, { jellyfinSyncStatus: "sync_error", jellyfinLastError: message });
    addEvent("error", `Jellyfin inventory sync failed: ${message}`, "jellyfin", ownerId);
  }
}

export function startJellyfinSync(ownerId: string) {
  const config = getJellyfinConfig(ownerId);
  if (!config.configured) {
    throw new JellyfinConfigurationError(
      "Configure a Jellyfin server URL and API key before syncing.",
    );
  }
  if (syncs.has(ownerId)) {
    throw new JellyfinConfigurationError("A Jellyfin synchronization is already running.");
  }
  const operation = syncJellyfinInventory(ownerId).finally(() => syncs.delete(ownerId));
  syncs.set(ownerId, operation);
  return getJellyfinConfig(ownerId);
}

export function readJellyfinInventory(ownerId: string) {
  const { serverUrl } = readJellyfinCredentials(ownerId);
  const libraries = archiveDb.prepare(`
    SELECT id, library_key, name, library_type, server_url, item_count, last_synced_at,
           sync_status, sync_error
    FROM jellyfin_library
    WHERE owner_id = ? AND server_url = ?
    ORDER BY name COLLATE NOCASE
  `).all(ownerId, serverUrl) as Array<Record<string, unknown>>;
  const items = archiveDb.prepare(`
    SELECT
      i.id, i.library_id, l.name AS library_name, i.item_key, i.title, i.item_type,
      i.year, i.thumb_url, i.added_at, i.updated_at,
      COUNT(DISTINCT m.id) AS media_count, COUNT(p.id) AS part_count
    FROM jellyfin_item i
    JOIN jellyfin_library l ON l.id = i.library_id AND l.owner_id = i.owner_id
    LEFT JOIN jellyfin_media m ON m.item_id = i.id
    LEFT JOIN jellyfin_part p ON p.media_id = m.id
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
      itemKey: String(item.item_key),
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
  "SELECT owner_id FROM user_setting WHERE key = 'jellyfinSyncStatus' AND value = '\"syncing\"'",
).all() as Array<{ owner_id: string }>;
for (const row of interruptedSyncs) {
  writeState(row.owner_id, {
    jellyfinSyncStatus: "sync_error",
    jellyfinLastError: "Jellyfin synchronization was interrupted by an application restart.",
  });
  addEvent(
    "warning",
    "Jellyfin synchronization was interrupted by an application restart.",
    "jellyfin",
    row.owner_id,
  );
}
