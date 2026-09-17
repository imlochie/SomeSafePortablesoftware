import type { ExternalIntegrationId } from "./contracts";
import { persistedIntegrationConfiguration } from "./persisted-config";

export interface IntegrationConfiguration {
  endpoint: string | null;
  credentialsConfigured: boolean;
  webhookSecret?: string | null;
  webhookSecrets?: () => readonly (string | null | undefined)[];
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
  rootFolderPath?: string | null;
  qualityProfileId?: number | null;
  languageProfileId?: number | null;
}

// Plex and Jellyfin are service-backed adapters: their credentials live in
// owner-scoped settings rather than process environment variables.
export type ExternalIntegrationConfiguration = Record<
  ExternalIntegrationId,
  IntegrationConfiguration
>;

function readValue(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  return value || null;
}

function hasAll(env: NodeJS.ProcessEnv, keys: string[]) {
  return keys.every((key) => Boolean(readValue(env, key)));
}

function optionalInteger(env: NodeJS.ProcessEnv, key: string) {
  const value = readValue(env, key);
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${key} value.`);
  }
  return parsed;
}

export function resolveExternalIntegrationConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ExternalIntegrationConfiguration {
  const stored = persistedIntegrationConfiguration(env);
  const value = (id: ExternalIntegrationId, key: string, envKey: string) => stored[id][key as keyof typeof stored[typeof id]] ?? readValue(env, envKey);
  const integer = (id: ExternalIntegrationId, key: string, envKey: string) => { const raw = value(id, key, envKey); return raw == null || raw === "" ? null : Number(raw); };
  return {
    sonarr: {
      endpoint: value("sonarr", "endpoint", "SONARR_URL") as string | null,
      credentialsConfigured: Boolean(value("sonarr", "apiKey", "SONARR_API_KEY")),
      webhookSecret: value("sonarr", "webhookSecret", "SONARR_WEBHOOK_SECRET") as string | null,
      apiKey: value("sonarr", "apiKey", "SONARR_API_KEY") as string | null,
      rootFolderPath: value("sonarr", "rootFolderPath", "SONARR_ROOT_FOLDER") as string | null,
      qualityProfileId: integer("sonarr", "qualityProfileId", "SONARR_QUALITY_PROFILE_ID"),
      languageProfileId: integer("sonarr", "languageProfileId", "SONARR_LANGUAGE_PROFILE_ID"),
    },
    radarr: {
      endpoint: value("radarr", "endpoint", "RADARR_URL") as string | null,
      credentialsConfigured: Boolean(value("radarr", "apiKey", "RADARR_API_KEY")),
      webhookSecret: readValue(env, "RADARR_WEBHOOK_SECRET"),
      apiKey: value("radarr", "apiKey", "RADARR_API_KEY") as string | null,
      rootFolderPath: value("radarr", "rootFolderPath", "RADARR_ROOT_FOLDER") as string | null,
      qualityProfileId: optionalInteger(env, "RADARR_QUALITY_PROFILE_ID"),
    },
    prowlarr: {
      endpoint: value("prowlarr", "endpoint", "PROWLARR_URL") as string | null,
      credentialsConfigured: Boolean(value("prowlarr", "apiKey", "PROWLARR_API_KEY")),
      apiKey: value("prowlarr", "apiKey", "PROWLARR_API_KEY") as string | null,
    },
    qbittorrent: {
      endpoint: value("qbittorrent", "endpoint", "QBITTORRENT_URL") as string | null,
      credentialsConfigured: Boolean(value("qbittorrent", "username", "QBITTORRENT_USERNAME") && value("qbittorrent", "password", "QBITTORRENT_PASSWORD")),
      username: value("qbittorrent", "username", "QBITTORRENT_USERNAME") as string | null,
      password: value("qbittorrent", "password", "QBITTORRENT_PASSWORD") as string | null,
    },
    mpilot: {
      endpoint: value("mpilot", "endpoint", "MPILOT_URL") as string | null,
      credentialsConfigured: Boolean(value("mpilot", "apiKey", "MPILOT_API_KEY")),
    },
    telegram: {
      endpoint: null,
      credentialsConfigured: Boolean(value("telegram", "apiKey", "TELEGRAM_BOT_TOKEN")),
      apiKey: value("telegram", "apiKey", "TELEGRAM_BOT_TOKEN") as string | null,
    },
  };
}