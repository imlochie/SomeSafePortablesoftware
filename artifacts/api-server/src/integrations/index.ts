import { plexAdapter } from "./adapters/plex";
import { placeholderAdapters } from "./adapters/placeholders";
import { IntegrationRegistry } from "./registry";
import { IntegrationService } from "./service";

const registry = new IntegrationRegistry().register(plexAdapter);
for (const adapter of placeholderAdapters) registry.register(adapter);
export const integrations = new IntegrationService(registry);
