import { existsSync, readFileSync, renameSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readSettings } from "../lib/archive-db";
import type { ExternalIntegrationConfiguration, IntegrationConfiguration } from "./config";
import type { ExternalIntegrationId } from "./contracts";

const ids: ExternalIntegrationId[] = ["sonarr", "radarr", "prowlarr", "qbittorrent", "mpilot", "telegram"];
type Stored = Partial<Record<ExternalIntegrationId, Partial<IntegrationConfiguration>>>;
function path() { return join(readSettings().dataDirectory, "integration-config.json"); }
function read(): Stored { try { return JSON.parse(readFileSync(path(), "utf8")) as Stored; } catch { return {}; } }
function clean(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
export function persistedIntegrationConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const stored = read();
  const base = { sonarr: {}, radarr: {}, prowlarr: {}, qbittorrent: {}, mpilot: {}, telegram: {} } as Record<ExternalIntegrationId, Partial<IntegrationConfiguration>>;
  for (const id of ids) Object.assign(base[id], stored[id] ?? {});
  return base;
}
export function saveIntegrationConfiguration(id: ExternalIntegrationId, input: Partial<IntegrationConfiguration>) {
  const current = read();
  const next = { ...(current[id] ?? {}) } as Record<string, unknown>;
  for (const [key, value] of Object.entries(input)) if (value !== undefined) next[key] = clean(value) ?? value;
  const file = path(); mkdirSync(dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...current, [id]: next }, null, 2), { encoding: "utf8", mode: 0o600 }); renameSync(temp, file);
}
export function readIntegrationConfigurationStatus() {
  const stored = read();
  return ids.map((id) => ({ id, configuredFields: Object.keys(stored[id] ?? {}).filter((key) => key !== "password"), hasSecret: Boolean(stored[id]?.apiKey || stored[id]?.password), configPath: "protected local configuration" }));
}
