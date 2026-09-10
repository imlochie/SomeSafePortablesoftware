import {
  IntegrationUnavailableError,
  type CapabilityHandlerMap,
  type IntegrationCapability,
  type IntegrationStatus,
  type MediaIntegrationAdapter,
} from "./contracts";
import type { IntegrationConfiguration } from "./config";
import {
  errorDetail,
  errorIsReachable,
  parseJsonText,
  requestJson,
  requestRaw,
  responseArray,
  responseRecord,
  stringField,
  type IntegrationHttpError,
} from "./http-client";

const capabilities = [
  "acquisition_job_creation",
  "acquisition_job_status",
  "media_inspection",
] as const satisfies readonly IntegrationCapability[];

function isConfigured(config: IntegrationConfiguration) {
  return Boolean(config.endpoint && config.username && config.password);
}

function configuredDetail(config: IntegrationConfiguration) {
  if (!config.endpoint && !config.username && !config.password) return "Not configured.";
  if (!config.endpoint) return "Base URL is required.";
  if (!config.username || !config.password) return "Username and password are required.";
  return null;
}

function cookieFrom(response: Headers) {
  const raw = response.get("set-cookie") ?? "";
  const match = raw.match(/(?:^|,\s*)SID=([^;,\s]+)/);
  return match?.[1] ?? null;
}

function cookieHeader(sid: string) {
  return { Cookie: `SID=${sid}` };
}

function parseTorrentRows(value: unknown) {
  return responseArray(value, "qBittorrent").map((item) => responseRecord(item, "qBittorrent"));
}

function mapTorrent(record: Record<string, unknown>) {
  const jobId = stringField(record, "hash", "magnet_uri", "name") ?? "";
  const title = stringField(record, "name");
  const progress = typeof record.progress === "number"
    ? Math.max(0, Math.min(1, record.progress))
    : null;
  const status = stringField(record, "state") ?? "unknown";
  const normalizedStatus = status.toLowerCase();
  const lifecycle = progress !== null && progress >= 1
    || ["uploading", "stalledup", "queuedup", "checkingup"].includes(normalizedStatus)
    ? "completed" as const
    : ["pausedup", "missingfiles", "error"].includes(normalizedStatus)
      ? "failed" as const
      : "active" as const;
  return {
    jobId,
    status,
    lifecycle,
    progress,
    title,
    mediaType: null,
    detail: title ? `qBittorrent reports ${title}.` : "qBittorrent returned a torrent status.",
    metadata: {
      hash: record.hash,
      savePath: record.save_path,
      contentPath: record.content_path,
      size: record.size,
      amountLeft: record.amount_left,
      downloaded: record.downloaded,
      completionOn: record.completion_on,
    },
  };
}

export function createQBittorrentAdapter(
  config: IntegrationConfiguration,
): MediaIntegrationAdapter {
  let sid: string | null = null;

  async function login() {
    if (!config.username || !config.password) {
      throw new IntegrationUnavailableError("qBittorrent credentials are required.", {
        integrationId: "qbittorrent",
      });
    }
    const response = await requestRaw(
      config,
      "qbittorrent",
      "/api/v2/auth/login",
      {
        method: "POST",
        includeApiKey: false,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          username: config.username,
          password: config.password,
        }),
      },
    );
    if (response.text.trim() !== "Ok.") {
      throw new Error("qBittorrent returned an invalid login response.");
    }
    const nextSid = cookieFrom(response.headers);
    if (!nextSid) {
      throw new Error("qBittorrent did not return a session cookie.");
    }
    sid = nextSid;
    return sid;
  }

  async function requestTorrent(
    path: string,
    options: Parameters<typeof requestRaw>[3] = {},
  ) {
    const session = sid ?? await login();
    try {
      return await requestRaw(config, "qbittorrent", path, {
        ...options,
        includeApiKey: false,
        headers: {
          ...options.headers,
          ...cookieHeader(session),
        },
      });
    } catch (error) {
      if ((error as IntegrationHttpError).statusCode === 403) {
        sid = null;
        const retrySession = await login();
        return requestRaw(config, "qbittorrent", path, {
          ...options,
          includeApiKey: false,
          headers: {
            ...options.headers,
            ...cookieHeader(retrySession),
          },
        });
      }
      throw error;
    }
  }

  const handlers: Partial<CapabilityHandlerMap> = {
    acquisition_job_creation: async (input) => {
      const metadata = input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
        ? input.metadata as Record<string, unknown>
        : {};
      const sourceUrl = input.sourceId
        ?? stringField(metadata, "torrentUrl", "magnetUrl", "url");
      if (!sourceUrl) {
        throw new IntegrationUnavailableError(
          "qBittorrent acquisition requires a torrent or magnet URL.",
          { integrationId: "qbittorrent", capability: "acquisition_job_creation" },
        );
      }
      const form = new URLSearchParams({ urls: sourceUrl });
      const savePath = stringField(metadata, "savePath");
      if (savePath) form.set("savepath", savePath);
      const category = stringField(metadata, "category");
      if (category) form.set("category", category);
      const response = await requestTorrent("/api/v2/torrents/add", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      });
      if (response.text.trim() !== "Ok.") {
        throw new Error("qBittorrent returned an invalid add-torrent response.");
      }
      return {
        accepted: true,
        jobId: stringField(metadata, "hash"),
        status: "accepted",
        detail: "qBittorrent accepted the acquisition job.",
      };
    },
    acquisition_job_status: async (input) => {
      const hash = input.jobId ?? input.externalId;
      const path = hash
        ? `/api/v2/torrents/info?hashes=${encodeURIComponent(hash)}`
        : "/api/v2/torrents/info";
      const response = await requestTorrent(path);
      return { jobs: parseTorrentRows(parseJsonText(response.text, "qBittorrent")).map(mapTorrent) };
    },
    media_inspection: async (input) => {
      const query = input.externalId
        ? `/api/v2/torrents/info?hashes=${encodeURIComponent(input.externalId)}`
        : "/api/v2/torrents/info";
      const response = await requestTorrent(query);
      const rows = parseTorrentRows(parseJsonText(response.text, "qBittorrent"));
      const filtered = input.title
        ? rows.filter((row) => stringField(row, "name")?.toLowerCase().includes(input.title!.toLowerCase()))
        : rows;
      const first = filtered[0];
      return first
        ? {
            found: true,
            title: stringField(first, "name"),
            mediaType: null,
            detail: "qBittorrent returned a matching download.",
            metadata: mapTorrent(first),
          }
        : {
            found: false,
            title: null,
            mediaType: null,
            detail: "qBittorrent did not return a matching download.",
          };
    },
  };

  return {
    id: "qbittorrent",
    name: "qBittorrent",
    capabilities,
    async getStatus(ownerId): Promise<IntegrationStatus> {
      void ownerId;
      const incomplete = configuredDetail(config);
      if (incomplete) {
        return {
          id: "qbittorrent",
          name: "qBittorrent",
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
        const response = await requestTorrent("/api/v2/app/version");
        if (!response.text.trim()) throw new Error("qBittorrent returned an empty version.");
        return {
          id: "qbittorrent",
          name: "qBittorrent",
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
          id: "qbittorrent",
          name: "qBittorrent",
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