import { resolveExternalIntegrationConfiguration } from "./config";
import { createDisconnectedAdapter } from "./disconnected-adapter";
import { createPlexAdapter } from "./plex-adapter";
import { createProwlarrAdapter } from "./prowlarr-adapter";
import { createQBittorrentAdapter } from "./qbittorrent-adapter";
import { createRadarrAdapter } from "./radarr-adapter";
import { createSonarrAdapter } from "./sonarr-adapter";
import { readWebhookSecretCandidates } from "../services/settings";
import {
  IntegrationUnavailableError,
  type AcquisitionWebhookEvent,
  type AcquisitionWebhookInput,
  integrationIds,
  type CapabilityContext,
  type CapabilityInputByName,
  type CapabilityResultByName,
  type IntegrationCapability,
  type IntegrationId,
  type IntegrationStatus,
  type MediaIntegrationAdapter,
} from "./contracts";

export interface ResolvedCapability<K extends IntegrationCapability> {
  adapter: MediaIntegrationAdapter;
  status: IntegrationStatus;
  execute: (
    input: CapabilityInputByName[K],
    context: CapabilityContext,
  ) => Promise<CapabilityResultByName[K]>;
}

export class IntegrationRegistry {
  private readonly adaptersById: ReadonlyMap<IntegrationId, MediaIntegrationAdapter>;

  constructor(adapters: readonly MediaIntegrationAdapter[]) {
    const ids = adapters.map((adapter) => adapter.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error("Integration registry cannot contain duplicate adapter IDs.");
    }
    this.adaptersById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  getAdapter(id: IntegrationId) {
    return this.adaptersById.get(id);
  }

  parseAcquisitionWebhook(
    id: IntegrationId,
    input: AcquisitionWebhookInput,
  ): AcquisitionWebhookEvent | null {
    const adapter = this.adaptersById.get(id);
    if (!adapter?.parseAcquisitionWebhook) {
      throw new IntegrationUnavailableError(
        `${id} does not support acquisition webhooks.`,
        { integrationId: id },
      );
    }
    return adapter.parseAcquisitionWebhook(input);
  }

  async getStatuses(ownerId: string): Promise<IntegrationStatus[]> {
    return Promise.all(
      integrationIds.map(async (id) => {
        const adapter = this.adaptersById.get(id);
        if (!adapter) {
          return {
            id,
            name: id,
            state: "error" as const,
            configured: false,
            reachable: false,
            operational: false,
            capabilities: [],
            detail: "No adapter is registered.",
            lastCheckedAt: null,
          };
        }
        try {
          return await adapter.getStatus(ownerId);
        } catch {
          return {
            id: adapter.id,
            name: adapter.name,
            state: "error" as const,
            configured: false,
            reachable: false,
            operational: false,
            capabilities: adapter.capabilities,
            detail: "Adapter health could not be read.",
            lastCheckedAt: null,
          };
        }
      }),
    );
  }

  async resolveCapability<K extends IntegrationCapability>(
    capability: K,
    ownerId: string,
    preferredIntegrationId?: IntegrationId,
  ): Promise<ResolvedCapability<K>> {
    const candidates = [...this.adaptersById.values()].filter((adapter) =>
      adapter.capabilities.includes(capability)
      && (!preferredIntegrationId || adapter.id === preferredIntegrationId)
    );
    if (!candidates.length) {
      throw new IntegrationUnavailableError(
        `No adapter provides the ${capability.replaceAll("_", " ")} capability.`,
        { capability },
      );
    }

    const statuses = await Promise.all(candidates.map(async (adapter) => ({
      adapter,
      status: await adapter.getStatus(ownerId),
    })));
    const selected = statuses.find(({ status }) => status.operational);
    if (!selected) {
      const requested = preferredIntegrationId ? ` for ${preferredIntegrationId}` : "";
      const unavailableDetail = statuses
        .map(({ adapter, status }) => `${adapter.name} is ${status.state}`)
        .join("; ");
      throw new IntegrationUnavailableError(
        `No operational adapter is available for the ${capability.replaceAll("_", " ")} capability${requested}. ${unavailableDetail}.`,
        { capability, integrationId: preferredIntegrationId },
      );
    }

    const execute = selected.adapter.getCapability(capability);
    if (!execute) {
      throw new IntegrationUnavailableError(
        `${selected.adapter.name} does not implement the ${capability.replaceAll("_", " ")} capability.`,
        { capability, integrationId: selected.adapter.id },
      );
    }
    return {
      adapter: selected.adapter,
      status: selected.status,
      execute: execute as ResolvedCapability<K>["execute"],
    };
  }

  async invoke<K extends IntegrationCapability>(
    capability: K,
    input: CapabilityInputByName[K],
    context: CapabilityContext,
    preferredIntegrationId?: IntegrationId,
  ): Promise<CapabilityResultByName[K]> {
    const resolved = await this.resolveCapability(capability, context.ownerId, preferredIntegrationId);
    return resolved.execute(input, context);
  }
}

export function createDefaultIntegrationRegistry(
  env: NodeJS.ProcessEnv = process.env,
) {
  const configuration = resolveExternalIntegrationConfiguration(env);
  return new IntegrationRegistry([
    createPlexAdapter(),
    createSonarrAdapter({
      ...configuration.sonarr,
      webhookSecrets: () => readWebhookSecretCandidates("sonarr", env),
    }),
    createRadarrAdapter({
      ...configuration.radarr,
      webhookSecrets: () => readWebhookSecretCandidates("radarr", env),
    }),
    createProwlarrAdapter(configuration.prowlarr),
    createQBittorrentAdapter(configuration.qbittorrent),
    createDisconnectedAdapter("mpilot", configuration.mpilot),
    createDisconnectedAdapter("telegram", configuration.telegram),
  ]);
}

export const integrationRegistry = createDefaultIntegrationRegistry();