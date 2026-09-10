import type { IntegrationId } from "./contracts";

export interface IntegrationConfiguration {
  endpoint: string | null;
  credentialsConfigured: boolean;
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

export function resolveExternalIntegrationConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ExternalIntegrationConfiguration {
  return {
    sonarr: {
      endpoint: readValue(env, "SONARR_URL"),
      credentialsConfigured: hasAll(env, ["SONARR_API_KEY"]),
    },
    radarr: {
      endpoint: readValue(env, "RADARR_URL"),
      credentialsConfigured: hasAll(env, ["RADARR_API_KEY"]),
    },
    prowlarr: {
      endpoint: readValue(env, "PROWLARR_URL"),
      credentialsConfigured: hasAll(env, ["PROWLARR_API_KEY"]),
    },
    qbittorrent: {
      endpoint: readValue(env, "QBITTORRENT_URL"),
      credentialsConfigured: hasAll(env, ["QBITTORRENT_USERNAME", "QBITTORRENT_PASSWORD"]),
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