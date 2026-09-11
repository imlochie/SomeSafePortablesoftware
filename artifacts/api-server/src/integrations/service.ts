import { readUserSetting, writeUserSetting } from "../lib/archive-db";
import { IntegrationError, type Capability, type CapabilityPayloads, type IntegrationConfiguration, type OwnerContext } from "./contracts";
import { IntegrationRegistry } from "./registry";

export class IntegrationService {
  constructor(private readonly registry: IntegrationRegistry) {}

  private context(ownerId: string): OwnerContext {
    if (!ownerId.trim()) throw new Error("Owner is required.");
    return Object.freeze({ ownerId });
  }

  private enabled(ownerId: string, id: string) {
    // Opt-in for new integrations. Existing configured providers remain usable.
    const value = readUserSetting(ownerId, `integration.${id}.enabled`);
    return typeof value === "boolean" ? value : this.registry.get(id).status(this.context(ownerId)).configured;
  }

  describe(ownerId: string, id: string) {
    const context = this.context(ownerId);
    const adapter = this.registry.get(id);
    const status = adapter.status(context);
    const enabled = this.enabled(ownerId, id);
    const implemented = Object.keys(adapter.handlers) as Capability[];
    return {
      id: adapter.id, name: adapter.name, enabled, ...status,
      capabilities: implemented,
      plannedCapabilities: [...adapter.plannedCapabilities],
      availableCapabilities: enabled && status.configured && status.state !== "unavailable" ? implemented.filter((capability) => status.state !== "disconnected" || capability === "media_host_inventory") : [],
    };
  }

  list(ownerId: string) { return this.registry.list().map((adapter) => this.describe(ownerId, adapter.id)); }
  discover(ownerId: string, capability: Capability) {
    return this.list(ownerId).filter((item) => item.availableCapabilities.includes(capability));
  }

  configure(ownerId: string, id: string, updates: IntegrationConfiguration) {
    this.context(ownerId);
    this.registry.get(id);
    if (typeof updates.enabled !== "boolean") throw new Error("enabled must be a boolean.");
    writeUserSetting(ownerId, `integration.${id}.enabled`, updates.enabled);
    return this.describe(ownerId, id);
  }

  async testConnection(ownerId: string, id: string) {
    const context = this.context(ownerId);
    const descriptor = this.describe(ownerId, id);
    if (descriptor.enabled && descriptor.configured && descriptor.state !== "unavailable") {
      try { await this.registry.get(id).testConnection(context); }
      catch { throw new IntegrationError("unavailable"); }
    }
    return this.describe(ownerId, id);
  }

  async execute<K extends Capability>(ownerId: string, id: string, capability: K): Promise<CapabilityPayloads[K]> {
    const context = this.context(ownerId);
    const adapter = this.registry.get(id);
    const handler = adapter.handlers[capability];
    if (!handler) throw new IntegrationError("unsupported");
    const descriptor = this.describe(ownerId, id);
    if (!descriptor.enabled) throw new IntegrationError("disabled");
    if (!descriptor.configured) throw new IntegrationError("not_configured");
    if (descriptor.state === "unavailable") throw new IntegrationError("unavailable");
    // Inventory is explicitly cached and remains readable during connection failures.
    if (descriptor.state === "disconnected" && capability !== "media_host_inventory") throw new IntegrationError("unavailable");
    try { return await handler(context); }
    catch { throw new IntegrationError("unavailable"); }
  }
}
