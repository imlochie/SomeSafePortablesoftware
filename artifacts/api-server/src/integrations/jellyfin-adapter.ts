import {
  getJellyfinConfig,
  readJellyfinInventory,
  startJellyfinSync,
} from "../services/jellyfin";
import {
  type ArchiveSearchRecord,
  type CapabilityHandler,
  type CapabilityHandlerMap,
  type IntegrationCapability,
  type IntegrationStatus,
  type MediaIntegrationAdapter,
} from "./contracts";

const capabilities = [
  "archive_search",
  "media_inspection",
  "media_verification",
  "library_scan",
] as const satisfies readonly IntegrationCapability[];

function matchesQuery(value: string, query: string) {
  return !query || value.toLowerCase().includes(query);
}

function findJellyfinItem(ownerId: string, externalId?: string, title?: string) {
  const inventory = readJellyfinInventory(ownerId);
  return inventory.items.find((item) =>
    (externalId && item.itemKey === externalId)
    || (title && item.title.toLowerCase() === title.toLowerCase())
  );
}

export function createJellyfinAdapter(): MediaIntegrationAdapter {
  const handlers: Partial<CapabilityHandlerMap> = {
    archive_search: async (input, context) => {
      const query = input.query.trim().toLowerCase();
      const inventory = readJellyfinInventory(context.ownerId);
      const records: ArchiveSearchRecord[] = inventory.items
        .filter((item) =>
          matchesQuery(item.title, query)
          && (!input.mediaType || item.itemType === input.mediaType)
        )
        .map((item) => ({
          externalId: item.itemKey,
          title: item.title,
          mediaType: item.itemType,
          year: item.year,
          source: "jellyfin",
          metadata: {
            libraryId: item.libraryId,
            libraryName: item.libraryName,
            mediaCount: item.mediaCount,
            partCount: item.partCount,
          },
        }));
      return { records };
    },
    media_inspection: async (input, context) => {
      const item = findJellyfinItem(context.ownerId, input.externalId, input.title);
      return item
        ? {
          found: true,
          title: item.title,
          mediaType: item.itemType,
          detail: `Jellyfin inventory contains ${item.title}.`,
          metadata: {
            itemKey: item.itemKey,
            mediaCount: item.mediaCount,
            partCount: item.partCount,
            libraryName: item.libraryName,
          },
        }
        : {
          found: false,
          title: null,
          mediaType: null,
          detail: "Jellyfin inventory did not contain a matching item.",
        };
    },
    media_verification: async (input, context) => {
      const item = findJellyfinItem(context.ownerId, input.externalId);
      const verified = Boolean(item && item.mediaCount > 0 && item.partCount > 0);
      return {
        verified,
        detail: verified
          ? "Jellyfin inventory contains at least one media part."
          : "Jellyfin inventory does not contain a verified media part.",
        evidence: item
          ? {
            itemKey: item.itemKey,
            mediaCount: item.mediaCount,
            partCount: item.partCount,
          }
          : {},
      };
    },
    library_scan: async (_input, context) => {
      startJellyfinSync(context.ownerId);
      return {
        accepted: true,
        status: "queued",
        detail: "Jellyfin inventory synchronization was queued.",
      };
    },
  };

  return {
    id: "jellyfin",
    name: "Jellyfin",
    capabilities,
    async getStatus(ownerId): Promise<IntegrationStatus> {
      const config = getJellyfinConfig(ownerId);
      const connected = config.connectionStatus === "connected";
      const state = !config.configured
        ? "disconnected"
        : config.connectionStatus === "connection_failed"
          ? "error"
          : connected
            ? "operational"
            : "configured";
      return {
        id: "jellyfin",
        name: "Jellyfin",
        state,
        configured: config.configured,
        reachable: connected,
        operational: connected,
        capabilities,
        detail: !config.configured
          ? "Not configured."
          : config.lastError && !connected
            ? config.lastError
            : connected
              ? `Connected${config.serverName ? ` to ${config.serverName}` : ""}.`
              : "Configuration is present; connection has not been verified.",
        lastCheckedAt: config.lastAttemptedAt,
      };
    },
    getCapability(capability) {
      return handlers[capability] as CapabilityHandler<typeof capability> | undefined;
    },
  };
}
