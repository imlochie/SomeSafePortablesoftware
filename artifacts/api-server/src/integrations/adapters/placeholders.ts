import type { Capability, IntegrationAdapter } from "../contracts";

function placeholder(id: string, name: string, plannedCapabilities: Capability[]): IntegrationAdapter {
  const status = () => ({ state: "unavailable" as const, configured: false, lastSuccessfulSyncAt: null });
  return { id, name, plannedCapabilities, handlers: {}, status, testConnection: async () => status() };
}

/** Catalog entries, NOT simulated providers. No credentials, transport, or execution. */
export const placeholderAdapters = [
  placeholder("sonarr", "Sonarr", ["availability_lookup", "acquisition_request"]),
  placeholder("radarr", "Radarr", ["availability_lookup", "acquisition_request"]),
  placeholder("prowlarr", "Prowlarr", ["search_source"]),
  placeholder("qbittorrent", "qBittorrent", ["download_status", "completed_item_notification"]),
  // MPilot's concrete capabilities require a verified product/API contract.
  placeholder("mpilot", "MPilot", []),
  placeholder("telegram", "Telegram", ["request_ingestion"]),
];
