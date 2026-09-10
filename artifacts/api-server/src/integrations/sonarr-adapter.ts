import type { IntegrationConfiguration } from "./config";
import { createArrAdapter } from "./arr-adapter";

export function createSonarrAdapter(config: IntegrationConfiguration) {
  return createArrAdapter("sonarr", config);
}