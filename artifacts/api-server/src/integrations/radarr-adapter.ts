import type { IntegrationConfiguration } from "./config";
import { createArrAdapter } from "./arr-adapter";

export function createRadarrAdapter(config: IntegrationConfiguration) {
  return createArrAdapter("radarr", config);
}