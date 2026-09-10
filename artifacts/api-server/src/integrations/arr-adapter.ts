import { createHmac, timingSafeEqual } from "node:crypto";
import {
  IntegrationUnavailableError,
  IntegrationWebhookAuthenticationError,
  type AcquisitionWebhookEvent,
  type AcquisitionWebhookInput,
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

function webhookHeader(input: AcquisitionWebhookInput, kind: ArrKind) {
  return [
    input.headers[`x-${kind}-webhook-signature`],
    input.headers["x-archive-webhook-signature"],
    input.headers["x-webhook-signature"],
  ].find((value) => typeof value === "string" && value.trim())?.trim() ?? null;
}

function verifyWebhookSignature(
  input: AcquisitionWebhookInput,
  kind: ArrKind,
  secret: string | null | undefined,
) {
  if (!secret) {
    throw new IntegrationUnavailableError(
      `${nameFor(kind)} webhook authentication is not configured.`,
      { integrationId: kind },
    );
  }
  const provided = webhookHeader(input, kind);
  if (!provided) throw new IntegrationWebhookAuthenticationError();
  const normalized = provided.replace(/^sha256=/i, "").trim();
  const expectedHex = createHmac("sha256", secret).update(input.rawBody).digest("hex");
  const expectedBase64 = createHmac("sha256", secret).update(input.rawBody).digest("base64");
  const matches = (expected: string) => {
    const actualBuffer = Buffer.from(normalized);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length
      && timingSafeEqual(actualBuffer, expectedBuffer);
  };
  if (!matches(expectedHex) && !matches(expectedBase64)) {
    throw new IntegrationWebhookAuthenticationError();
  }
}

function parseWebhookEvent(
  kind: ArrKind,
  input: AcquisitionWebhookInput,
  secrets: readonly (string | null | undefined)[],
): AcquisitionWebhookEvent | null {
  let authenticated = false;
  let hasSecret = false;
  for (const secret of secrets) {
    if (!secret) continue;
    hasSecret = true;
    try {
      verifyWebhookSignature(input, kind, secret);
      authenticated = true;
      break;
    } catch (error) {
      if (!(error instanceof IntegrationWebhookAuthenticationError)) throw error;
    }
  }
  if (!authenticated) {
    if (!hasSecret) verifyWebhookSignature(input, kind, null);
    throw new IntegrationWebhookAuthenticationError();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    throw malformedResponse(`${nameFor(kind)} returned malformed webhook JSON.`);
  }
  const record = responseRecord(payload, nameFor(kind));
  const eventType = stringField(record, "eventType", "event", "type") ?? "unknown";
  const eventId = stringField(record, "eventId", "webhookId", "notificationId");
  const providerJobId = stringField(record, "downloadId", "downloadID", "jobId", "providerJobId", "id");
  if (!providerJobId && eventType.toLowerCase() === "test") return null;
  if (!providerJobId) {
    throw malformedResponse(`${nameFor(kind)} webhook did not include a provider download identifier.`);
  }
  const normalizedEvent = eventType.toLowerCase();
  const lifecycle = normalizedEvent.includes("failed")
    || normalizedEvent.includes("error")
    || normalizedEvent.includes("aborted")
    ? "failed" as const
    : normalizedEvent.includes("download")
      || normalizedEvent.includes("import")
      || normalizedEvent.includes("complete")
      ? "completed" as const
      : "active" as const;
  const rawProgress = numberField(record, "progress", "downloadProgress");
  const progress = rawProgress === null
    ? null
    : Math.max(0, Math.min(1, rawProgress > 1 ? rawProgress / 100 : rawProgress));
  const titleRecord = record.series && typeof record.series === "object"
    ? record.series as Record<string, unknown>
    : record.movie && typeof record.movie === "object"
      ? record.movie as Record<string, unknown>
      : {};
  const title = stringField(titleRecord, "title", "seriesName")
    ?? stringField(record, "title", "name");
  const detail = title
    ? `${nameFor(kind)} webhook ${eventType} for ${title}.`
    : `${nameFor(kind)} webhook reports ${eventType}.`;
  return {
    providerJobId,
    status: eventType,
    lifecycle,
    progress,
    providerReference: stringField(record, "downloadClient", "downloadId"),
    detail,
    eventId,
    metadata: {
      providerWebhookEvent: eventType,
      ...(eventId ? { providerWebhookEventId: eventId } : {}),
      ...(title ? { providerWebhookTitle: title } : {}),
      ...(record.downloadClient ? { downloadClient: record.downloadClient } : {}),
    },
  };
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
  const status = stringField(record, "status", "trackedDownloadStatus") ?? "unknown";
  const normalizedStatus = status.toLowerCase();
  const lifecycle = ["failed", "error", "aborted", "missing"].some((value) =>
    normalizedStatus.includes(value)
  )
    ? "failed" as const
    : ["completed", "imported", "downloaded"].some((value) =>
        normalizedStatus.includes(value)
      )
      ? "completed" as const
      : "active" as const;
  return {
    jobId: String(numberField(record, "id", "downloadId") ?? stringField(record, "downloadId") ?? ""),
    status,
    lifecycle,
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
    parseAcquisitionWebhook(input) {
      return parseWebhookEvent(
        kind,
        input,
        config.webhookSecrets?.() ?? [config.webhookSecret],
      );
    },
  };
}