import type { IntegrationId } from "./contracts";

export interface IntegrationConfiguration {
  endpoint: string | null;
  credentialsConfigured: boolean;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
  rootFolderPath?: string | null;
  qualityProfileId?: number | null;
  languageProfileId?: number | null;
}

export type ExternalIntegrationConfiguration = Record<
  Exclude<IntegrationId, "plex">,
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
  return {
    sonarr: {
      endpoint: readValue(env, "SONARR_URL"),
      credentialsConfigured: hasAll(env, ["SONARR_API_KEY"]),
      apiKey: readValue(env, "SONARR_API_KEY"),
      rootFolderPath: readValue(env, "SONARR_ROOT_FOLDER"),
      qualityProfileId: optionalInteger(env, "SONARR_QUALITY_PROFILE_ID"),
      languageProfileId: optionalInteger(env, "SONARR_LANGUAGE_PROFILE_ID"),
    },
    radarr: {
      endpoint: readValue(env, "RADARR_URL"),
      credentialsConfigured: hasAll(env, ["RADARR_API_KEY"]),
      apiKey: readValue(env, "RADARR_API_KEY"),
      rootFolderPath: readValue(env, "RADARR_ROOT_FOLDER"),
      qualityProfileId: optionalInteger(env, "RADARR_QUALITY_PROFILE_ID"),
    },
    prowlarr: {
      endpoint: readValue(env, "PROWLARR_URL"),
      credentialsConfigured: hasAll(env, ["PROWLARR_API_KEY"]),
      apiKey: readValue(env, "PROWLARR_API_KEY"),
    },
    qbittorrent: {
      endpoint: readValue(env, "QBITTORRENT_URL"),
      credentialsConfigured: hasAll(env, ["QBITTORRENT_USERNAME", "QBITTORRENT_PASSWORD"]),
      username: readValue(env, "QBITTORRENT_USERNAME"),
      password: readValue(env, "QBITTORRENT_PASSWORD"),
    },
    mpilot: {
      endpoint: readValue(env, "MPILOT_URL"),
      credentialsConfigured: hasAll(env, ["MPILOT_API_KEY"]),
    },
    telegram: {
      endpoint: null,
      credentialsConfigured: hasAll(env, ["TELEGRAM_BOT_TOKEN"]),
    },
  };
}