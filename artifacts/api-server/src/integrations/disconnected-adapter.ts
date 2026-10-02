import {
  IntegrationUnavailableError,
  type CapabilityContext,
  type CapabilityHandler,
  type ExternalIntegrationId,
  type IntegrationCapability,
  type IntegrationId,
  type IntegrationStatus,
  type MediaIntegrationAdapter,
} from "./contracts";
import type {
  ExternalIntegrationConfiguration,
  IntegrationConfiguration,
} from "./config";

const labels: Record<ExternalIntegrationId, string> = {
  sonarr: "Sonarr",
  radarr: "Radarr",
  prowlarr: "Prowlarr",
  qbittorrent: "qBittorrent",
  mpilot: "MPilot",
  telegram: "Telegram ingestion",
};

const adapterCapabilities: Record<ExternalIntegrationId, readonly IntegrationCapability[]> = {
  sonarr: ["media_lookup", "missing_media_discovery", "source_inspection", "acquisition_job_creation", "acquisition_job_status"],
  radarr: ["media_lookup", "missing_media_discovery", "source_inspection", "acquisition_job_creation", "acquisition_job_status"],
  prowlarr: ["host_lookup", "source_inspection"],
  qbittorrent: ["acquisition_job_creation", "acquisition_job_status", "media_inspection"],
  mpilot: [
    "archive_search",
    "media_lookup",
    "host_lookup",
    "missing_media_discovery",
    "source_inspection",
    "acquisition_job_creation",
    "acquisition_job_status",
    "media_inspection",
    "media_verification",
    "rename_move",
    "library_scan",
  ],
  telegram: ["source_inspection", "acquisition_job_creation"],
};

function unavailableHandler(
  id: IntegrationId,
  name: string,
  capability: IntegrationCapability,
): CapabilityHandler<IntegrationCapability> {
  return async (_input: never, _context: CapabilityContext) => {
    throw new IntegrationUnavailableError(
      `${name} is disconnected; the ${capability.replaceAll("_", " ")} capability is unavailable.`,
      { integrationId: id, capability },
    );
  };
}

function getConfiguredDetail(config: IntegrationConfiguration) {
  return config.endpoint || config.credentialsConfigured
    ? "Configuration is present, but this adapter is not available yet."
    : "Not configured.";
}

export function createDisconnectedAdapter(
  id: ExternalIntegrationId,
  config: ExternalIntegrationConfiguration[typeof id],
): MediaIntegrationAdapter {
  const name = labels[id];
  const capabilities = adapterCapabilities[id];
  return {
    id,
    name,
    capabilities,
    async getStatus(_ownerId) {
      return {
        id,
        name,
        state: "disconnected",
        configured: Boolean(config.endpoint || config.credentialsConfigured),
        reachable: false,
        operational: false,
        capabilities,
        detail: getConfiguredDetail(config),
        lastCheckedAt: null,
      };
    },
    getCapability(capability) {
      if (!capabilities.includes(capability)) return undefined;
      return unavailableHandler(id, name, capability) as CapabilityHandler<typeof capability>;
    },
  };
}