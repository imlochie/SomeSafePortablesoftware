import { getPlexConfig, readPlexInventory, testPlexConnection } from "../../services/plex";
import type { ConnectionStatus, IntegrationAdapter, MediaIdentity, OwnerContext } from "../contracts";

function status({ ownerId }: OwnerContext): ConnectionStatus {
  const config = getPlexConfig(ownerId);
  return {
    configured: config.configured,
    state: !config.configured ? "not_configured"
      : config.connectionStatus === "connection_failed" ? "disconnected"
      : config.connectionStatus === "connected" ? "connected" : "configured",
    lastSuccessfulSyncAt: config.lastSuccessfulSyncAt,
  };
}

/** Existing transport/persistence remains the private implementation of this adapter. */
export const plexAdapter: IntegrationAdapter = {
  id: "plex",
  name: "Plex",
  plannedCapabilities: [],
  status,
  async testConnection(context) {
    await testPlexConnection(context.ownerId);
    return status(context);
  },
  handlers: {
    async media_host_inventory(context) {
      const config = status(context);
      return {
        cached: true,
        lastSuccessfulSyncAt: config.lastSuccessfulSyncAt,
        items: readPlexInventory(context.ownerId).items.map((item): MediaIdentity => ({
          id: String(item.id),
          title: item.title,
          kind: item.itemType === "movie" || item.itemType === "show" || item.itemType === "episode" ? item.itemType : "other",
          year: item.year,
        })),
      };
    },
  },
};
