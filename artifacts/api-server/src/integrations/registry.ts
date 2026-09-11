import { capabilities, IntegrationError, type Capability, type IntegrationAdapter } from "./contracts";

/** Definitions only: never store credentials, owner state, or owner-bound instances here. */
export class IntegrationRegistry {
  private readonly adapters = new Map<string, IntegrationAdapter>();

  register(adapter: IntegrationAdapter) {
    if (!/^[a-z][a-z0-9-]*$/.test(adapter.id) || this.adapters.has(adapter.id)) {
      throw new Error(`Invalid or duplicate integration ID: ${adapter.id}`);
    }
    for (const capability of Object.keys(adapter.handlers)) {
      if (!capabilities.includes(capability as Capability) || typeof adapter.handlers[capability as Capability] !== "function") {
        throw new Error(`Invalid capability: ${capability}`);
      }
    }
    for (const capability of adapter.plannedCapabilities) {
      if (!capabilities.includes(capability) || adapter.handlers[capability]) {
        throw new Error(`Invalid or already implemented planned capability: ${capability}`);
      }
    }
    this.adapters.set(adapter.id, Object.freeze({
      ...adapter,
      plannedCapabilities: Object.freeze([...adapter.plannedCapabilities]),
      handlers: Object.freeze({ ...adapter.handlers }),
    }));
    return this;
  }

  get(id: string) {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new IntegrationError("not_found");
    return adapter;
  }

  list() { return [...this.adapters.values()]; }
  discover(capability: Capability) { return this.list().filter((adapter) => Boolean(adapter.handlers[capability])); }
}
