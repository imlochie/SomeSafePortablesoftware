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

type ArrKind = "sonarr" | "radarr";

const arrCapabilities: Record<ArrKind, readonly IntegrationCapability[]> = {
  sonarr: [
    "media_lookup",
    "missing_media_discovery",
    "source_inspection",
    "acquisition_job_creation",
    "acquisition_job_status",
  ],
  radarr: [
    "media_lookup",
    "missing_media_discovery",
    "source_inspection",
    "acquisition_job_creation",
    "acquisition_job_status",
  ],
};

function nameFor(kind: ArrKind) {
  return kind === "sonarr" ? "Sonarr" : "Radarr";
}

function apiRoot(kind: ArrKind) {
  return kind === "sonarr" ? "/api/v3" : "/api/v3";
}

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

function metadataRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredExternalId(record: Record<string, unknown>, service: string) {
  const id = numberField(record, "id", "tvdbId", "tmdbId");
  if (id === null) {
    throw malformedResponse(`${service} returned an item without an identifier.`);
  }
  return String(id);
}

function mapLookup(kind: ArrKind, value: unknown): ArchiveSearchRecord {
  const record = responseRecord(value, nameFor(kind));
  const title = stringField(record, "title", "seriesName", "movieFileName");
  if (!title) throw malformedResponse(`${nameFor(kind)} returned a lookup item without a title.`);
  return {
    externalId: requiredExternalId(record, nameFor(kind)),
    title,
    mediaType: kind === "sonarr" ? "series" : "movie",
    year: numberField(record, "year"),
    source: kind,
    metadata: {
      tvdbId: numberField(record, "tvdbId"),
      tmdbId: numberField(record, "tmdbId"),
      monitored: record.monitored,
      overview: record.overview,
    },
  };
}

function mapMissing(kind: ArrKind, value: unknown) {
  const record = responseRecord(value, nameFor(kind));
  const nested = record.series && typeof record.series === "object"
    ? record.series as Record<string, unknown>
    : record.movie && typeof record.movie === "object"
      ? record.movie as Record<string, unknown>
      : {};
  const title = stringField(nested, "title") ?? stringField(record, "title", "seriesName");
  if (!title) throw malformedResponse(`${nameFor(kind)} returned missing media without a title.`);
  return {
    externalId: String(numberField(record, "id", "episodeId", "movieId") ?? title),
    title,
    mediaType: kind === "sonarr" ? "episode" : "movie",
    year: numberField(nested, "year") ?? numberField(record, "year"),
    detail: kind === "sonarr"
      ? `Season ${numberField(record, "seasonNumber") ?? 0}, episode ${numberField(record, "episodeNumber") ?? 0} is missing.`
      : "Movie file is missing.",
  };
}

function mapQueue(kind: ArrKind, value: unknown) {
  const record = responseRecord(value, nameFor(kind));
  const nested = record.series && typeof record.series === "object"
    ? record.series as Record<string, unknown>
    : record.movie && typeof record.movie === "object"
      ? record.movie as Record<string, unknown>
      : {};
  const size = numberField(record, "size");
  const sizeLeft = numberField(record, "sizeleft");
  return {
    jobId: String(numberField(record, "id", "downloadId") ?? stringField(record, "downloadId") ?? ""),
    status: stringField(record, "status", "trackedDownloadStatus") ?? "unknown",
    progress: size !== null && size > 0 && sizeLeft !== null
      ? Math.max(0, Math.min(1, (size - sizeLeft) / size))
      : numberField(record, "progress"),
    title: stringField(nested, "title") ?? stringField(record, "title"),
    mediaType: kind === "sonarr" ? "episode" : "movie",
    detail: stringField(record, "errorMessage", "statusMessages") ?? "Acquisition job status returned.",
    metadata: {
      downloadId: record.downloadId,
      protocol: record.protocol,
      downloadClient: record.downloadClient,
      trackedDownloadStatus: record.trackedDownloadStatus,
    },
  };
}

export function createArrAdapter(
  kind: ArrKind,
  config: IntegrationConfiguration,
): MediaIntegrationAdapter {
  const name = nameFor(kind);
  const root = apiRoot(kind);
  const capabilities = arrCapabilities[kind];
  const handlers: Partial<CapabilityHandlerMap> = {
    media_lookup: async (input) => {
      const query = input.query?.trim() || input.externalId?.trim();
      if (!query) {
        throw new IntegrationUnavailableError(`${name} lookup requires a query.`, {
          integrationId: kind,
          capability: "media_lookup",
        });
      }
      const payload = await requestJson<unknown>(
        config,
        kind,
        queryPath(`${root}/${kind === "sonarr" ? "series" : "movie"}/lookup`, { term: query }),
      );
      const records = responseArrayField(payload, [], name).map((item) => mapLookup(kind, item));
      return {
        records: input.mediaType
          ? records.filter((record) => record.mediaType === input.mediaType)
          : records,
      };
    },
    missing_media_discovery: async (input) => {
      const path = kind === "sonarr" ? "/wanted/missing" : "/wanted/missing";
      const payload = await requestJson<unknown>(
        config,
        kind,
        queryPath(`${root}${path}`, {
          page: "1",
          pageSize: "100",
          sortKey: kind === "sonarr" ? "airDateUtc" : "releaseDate",
          sortDirection: "descending",
          includeSeries: kind === "sonarr" ? "true" : undefined,
          monitored: kind === "radarr" ? "true" : undefined,
          includeMovieFile: kind === "radarr" ? "false" : undefined,
        }),
      );
      const items = responseArrayField(payload, ["records", "episodes", "movies"], name)
        .map((item) => mapMissing(kind, item));
      const query = input.query?.trim().toLowerCase();
      return {
        items: query
          ? items.filter((item) => item.title.toLowerCase().includes(query))
          : items,
      };
    },
    source_inspection: async (input) => {
      const id = Number(input.sourceId);
      if (!Number.isInteger(id) || id <= 0) {
        throw new IntegrationUnavailableError(`${name} lookup requires a numeric source ID.`, {
          integrationId: kind,
          capability: "source_inspection",
        });
      }
      const payload = await requestJson<unknown>(
        config,
        kind,
        `${root}/${kind === "sonarr" ? "series" : "movie"}/${id}`,
      );
      const record = responseRecord(payload, name);
      return {
        sourceId: input.sourceId,
        available: true,
        title: stringField(record, "title"),
        detail: `${name} returned the requested library item.`,
        metadata: record,
      };
    },
    acquisition_job_creation: async (input) => {
      const metadata = metadataRecord(input.metadata);
      if (input.externalId) {
        const command = kind === "sonarr"
          ? { name: "SeriesSearch", seriesId: Number(input.externalId) }
          : { name: "MoviesSearch", movieIds: [Number(input.externalId)] };
        const payload = await requestJson<unknown>(config, kind, `${root}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        });
        const response = responseRecord(payload, name);
        return {
          accepted: true,
          jobId: String(numberField(response, "id") ?? ""),
          status: "accepted",
          detail: `${name} search command accepted.`,
        };
      }

      const requestPayload = metadata.requestPayload && typeof metadata.requestPayload === "object"
        && !Array.isArray(metadata.requestPayload)
        ? metadata.requestPayload as Record<string, unknown>
        : metadata;
      const rootFolderPath = stringField(requestPayload, "rootFolderPath")
        ?? config.rootFolderPath;
      const qualityProfileId = numberField(requestPayload, "qualityProfileId")
        ?? config.qualityProfileId;
      if (!rootFolderPath || qualityProfileId === null) {
        throw new IntegrationUnavailableError(
          `${name} request requires an external ID or rootFolderPath and qualityProfileId configuration.`,
          { integrationId: kind, capability: "acquisition_job_creation" },
        );
      }
      const body: Record<string, unknown> = {
        ...requestPayload,
        title: requestPayload.title ?? input.title,
        rootFolderPath,
        qualityProfileId,
      };
      if (kind === "sonarr" && config.languageProfileId !== null && config.languageProfileId !== undefined) {
        body.languageProfileId = config.languageProfileId;
      }
      const payload = await requestJson<unknown>(config, kind, `${root}/${kind === "sonarr" ? "series" : "movie"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const response = responseRecord(payload, name);
      return {
        accepted: true,
        jobId: numberField(response, "id") === null ? null : String(numberField(response, "id")),
        status: "accepted",
        detail: `${name} acquisition request accepted.`,
      };
    },
    acquisition_job_status: async (input) => {
      const payload = await requestJson<unknown>(
        config,
        kind,
        queryPath(`${root}/queue`, {
          page: "1",
          pageSize: "100",
          includeUnknownMovieItems: kind === "radarr" ? "true" : undefined,
        }),
      );
      const jobs = responseArrayField(payload, ["records"], name)
        .map((item) => mapQueue(kind, item))
        .filter((job) => !input.jobId || job.jobId === input.jobId || job.metadata?.downloadId === input.jobId);
      return { jobs };
    },
  };

  return {
    id: kind,
    name,
    capabilities,
    async getStatus(ownerId): Promise<IntegrationStatus> {
      void ownerId;
      const incomplete = configuredDetail(config);
      if (incomplete) {
        return {
          id: kind,
          name,
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
        await requestJson<Record<string, unknown>>(config, kind, `${root}/system/status`);
        return {
          id: kind,
          name,
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
          id: kind,
          name,
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