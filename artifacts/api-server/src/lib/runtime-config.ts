import { join } from "node:path";
import { homedir } from "node:os";

export type AuthMode = "local" | "clerk";

function parseAuthMode(value: string | undefined): AuthMode {
  const normalized = value?.trim().toLowerCase() || "local";
  if (normalized === "local" || normalized === "clerk") return normalized;
  throw new Error(`Invalid AUTH_MODE value: "${value}". Expected "local" or "clerk".`);
}

function parsePort(value: string | undefined) {
  const normalized = value?.trim() || "8080";
  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid PORT value: "${value}".`);
  }
  return port;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value.trim().toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.trim().toLowerCase())) return false;
  throw new Error(`Invalid boolean value: "${value}".`);
}

function configured(value: string | undefined, fallback: string) {
  return value?.trim() || fallback;
}

function managedToolPath(
  value: string | undefined,
  fallback: string,
  managedDirectory: string | undefined,
) {
  const configuredValue = value?.trim();
  if (configuredValue) return configuredValue;
  if (!managedDirectory) return fallback;
  return join(
    managedDirectory,
    process.platform === "win32" ? `${fallback}.exe` : fallback,
  );
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const authMode = parseAuthMode(env.AUTH_MODE);
  const archiveRoot = join(homedir(), "ARCHIVE");
  const managedToolDirectory = env.ARCHIVE_MEDIA_TOOLS_DIR?.trim() || undefined;
  const developmentHostRequired =
    env.NODE_ENV !== "production" || env.REPL_ID !== undefined;

  return {
    authMode,
    localOwnerId: "__local__",
    port: parsePort(env.PORT),
    host: configured(
      env.API_HOST,
      authMode === "local" && !developmentHostRequired ? "127.0.0.1" : "0.0.0.0",
    ),
    allowAnyCorsOrigin: authMode === "clerk" || developmentHostRequired,
    allowedCorsOrigins: new Set(
      (env.API_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
    databasePath: configured(
      env.ARCHIVE_DB_PATH,
      join(process.cwd(), "data", "archive-assistant.sqlite"),
    ),
    paths: {
      data: configured(env.ARCHIVE_DATA_PATH, join(archiveRoot, "data")),
      downloads: configured(env.ARCHIVE_DOWNLOAD_PATH, join(archiveRoot, "downloads")),
      archive: configured(env.ARCHIVE_LIBRARY_PATH, join(archiveRoot, "library")),
      temporary: configured(env.ARCHIVE_TEMP_PATH, join(archiveRoot, "tmp")),
    },
    tools: {
      ytDlp: managedToolPath(env.YT_DLP_PATH, "yt-dlp", managedToolDirectory),
      ffmpeg: managedToolPath(env.FFMPEG_PATH, "ffmpeg", managedToolDirectory),
      ffprobe: managedToolPath(env.FFPROBE_PATH, "ffprobe", managedToolDirectory),
    },
    mockMode: parseBoolean(env.ARCHIVE_MOCK_MODE, true),
  } as const;
}

export const runtimeConfig = resolveRuntimeConfig();

export function isAllowedLocalOrigin(origin: string) {
  if (runtimeConfig.allowedCorsOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.protocol === "tauri:"
    );
  } catch {
    return false;
  }
}