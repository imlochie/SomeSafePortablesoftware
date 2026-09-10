import {
  IntegrationUnavailableError,
  type ArchiveSearchRecord,
  type CapabilityHandlerMap,
  type IntegrationCapability,
  type IntegrationStatus,
  type MediaIntegrationAdapter,
} from "./contracts";
import type { IntegrationConfiguration } from "./config";
import {
  errorDetail,
  errorIsReachable,
  malformedResponse,
  numberField,
  requestJson,
  responseArrayField,
  responseRecord,
  stringField,
} from "./http-client";

const capabilities = [
  "archive_search",
  "host_lookup",
  "source_inspection",
] as const satisfies readonly IntegrationCapability[];

function isConfigured(config: IntegrationConfiguration) {
  return Boolean(config.endpoint && config.apiKey);
}

function configuredDetail(config: IntegrationConfiguration) {
  if (!config.endpoint && !config.apiKey) return "Not configured.";
  if (!config.endpoint) return "Base URL is required.";
  if (!config.apiKey) return "API key is required.";
  return null;
}

function queryPath(path: string, params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  return `${path}?${search.toString()}`;
}

function mapSearchResult(value: unknown): ArchiveSearchRecord {
  const record = responseRecord(value, "Prowlarr");
  const title = stringField(record, "title", "name");
  if (!title) throw malformedResponse("Prowlarr returned a search result without a title.");
  const externalId = stringField(record, "guid", "downloadUrl", "infoUrl");
  if (!externalId) throw malformedResponse("Prowlarr returned a search result without an identifier.");
  return {
    externalId,
    title,
    mediaType: "source",
    year: numberField(record, "year"),
    source: "prowlarr",
    metadata: {
      indexer: record.indexer,
      indexerId: record.indexerId,
      downloadUrl: record.downloadUrl,
      magnetUrl: record.magnetUrl,
      size: record.size,
      seeders: record.seeders,
      leechers: record.leechers,
    },
  };
}

function indexerHost(record: Record<string, unknown>, fallback: string) {
  const fields = Array.isArray(record.fields) ? record.fields : [];
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const item = field as Record<string, unknown>;
    const key = stringField(item, "name");
    const value = stringField(item, "value");
    if (key && value && /url|host/i.test(key)) {
      try {
        return new URL(value).hostname;
      } catch {
        return value;
      }
    }
  }
  return fallback;
}

export function createProwlarrAdapter(
  config: IntegrationConfiguration,
): MediaIntegrationAdapter {
  const handlers: Partial<CapabilityHandlerMap> = {
    archive_search: async (input) => {
      const query = input.query.trim();
      if (!query) {
        throw new IntegrationUnavailableError("Prowlarr search requires a query.", {
          integrationId: "prowlarr",
          capability: "archive_search",
        });
      }
      const payload = await requestJson<unknown>(
        config,
        "prowlarr",
        queryPath("/api/v1/search", { query, type: "search" }),
      );
      return {
        records: responseArrayField(payload, ["results", "records"], "Prowlarr")
          .map(mapSearchResult),
      };
    },
    host_lookup: async (input) => {
      const payload = await requestJson<unknown>(config, "prowlarr", "/api/v1/indexer");
      const indexers = responseArrayField(payload, [], "Prowlarr");
      const query = input.query.trim().toLowerCase();
      const record = indexers
        .map((item) => responseRecord(item, "Prowlarr"))
        .find((item) =>
          !query
          || String(item.id ?? "").toLowerCase() === query
          || (stringField(item, "name", "implementationName") ?? "").toLowerCase().includes(query)
        );
      if (!record) {
        return {
          host: input.query,
          port: null,
          reachable: false,
          detail: "No matching Prowlarr indexer was found.",
        };
      }
      const endpoint = config.endpoint ? new URL(config.endpoint) : null;
      return {
        host: indexerHost(record, endpoint?.hostname ?? ""),
        port: endpoint?.port ? Number(endpoint.port) : null,
        reachable: true,
        detail: "Prowlarr indexer was found.",
      };
    },
    source_inspection: async (input) => {
      const id = Number(input.sourceId);
      if (!Number.isInteger(id) || id <= 0) {
        throw new IntegrationUnavailableError("Prowlarr source inspection requires a numeric indexer ID.", {
          integrationId: "prowlarr",
          capability: "source_inspection",
        });
      }
      const payload = await requestJson<unknown>(config, "prowlarr", `/api/v1/indexer/${id}`);
      const record = responseRecord(payload, "Prowlarr");
      return {
        sourceId: input.sourceId,
        available: Boolean(record.enable !== false),
        title: stringField(record, "name", "implementationName"),
        detail: "Prowlarr returned the requested indexer.",
        metadata: record,
      };
    },
  };

  return {
    id: "prowlarr",
    name: "Prowlarr",
    capabilities,
    async getStatus(ownerId): Promise<IntegrationStatus> {
      void ownerId;
      const incomplete = configuredDetail(config);
      if (incomplete) {
        return {
          id: "prowlarr",
          name: "Prowlarr",
          state: "disconnected",
          configured: false,
          reachable: false,
          operational: false,
          capabilities,
          detail: incomplete,
          lastCheckedAt: null,
        };
      }
      try {
        await requestJson<Record<string, unknown>>(config, "prowlarr", "/api/v1/system/status");
        return {
          id: "prowlarr",
          name: "Prowlarr",
          state: "operational",
          configured: isConfigured(config),
          reachable: true,
          operational: true,
          capabilities,
          detail: "Health check succeeded.",
          lastCheckedAt: new Date().toISOString(),
        };
      } catch (error) {
        return {
          id: "prowlarr",
          name: "Prowlarr",
          state: "error",
          configured: isConfigured(config),
          reachable: errorIsReachable(error),
          operational: false,
          capabilities,
          detail: errorDetail(error),
          lastCheckedAt: new Date().toISOString(),
        };
      }
    },
    getCapability(capability) {
      return handlers[capability] as typeof handlers[typeof capability];
    },
  };
}