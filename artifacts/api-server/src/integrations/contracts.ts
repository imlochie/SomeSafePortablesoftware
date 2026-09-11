/** Provider-neutral vocabulary. Reserved capabilities are not executable promises. */
export const capabilities = [
  "media_host_inventory", "search_source", "availability_lookup", "acquisition_request",
  "download_status", "completed_item_notification", "request_ingestion",
] as const;
export type Capability = typeof capabilities[number];
/** Stored in owner-scoped user_setting; provider secrets never belong in descriptors. */
export interface IntegrationConfiguration { enabled: boolean }
export type OwnerContext = Readonly<{ ownerId: string }>;
export type ConnectionState = "not_configured" | "configured" | "connected" | "disconnected" | "unavailable";
export interface ConnectionStatus {
  state: ConnectionState;
  configured: boolean;
  lastSuccessfulSyncAt: string | null;
}
export interface MediaIdentity {
  id: string; // Opaque, integration-local reference; never parse this in the control plane.
  title: string;
  kind: "movie" | "show" | "episode" | "other";
  year: number | null;
}
export interface MediaInventory {
  items: MediaIdentity[];
  cached: true;
  lastSuccessfulSyncAt: string | null;
}
/** Data-only extension contracts; no acquisition execution is wired in this foundation. */
export interface CapabilityPayloads {
  media_host_inventory: MediaInventory;
  search_source: { items: MediaIdentity[] };
  availability_lookup: { item: MediaIdentity; available: boolean };
  acquisition_request: { requestId: string; item: MediaIdentity };
  download_status: { id: string; state: "pending" | "active" | "complete" | "failed"; progress: number };
  completed_item_notification: { id: string; item: MediaIdentity; completedAt: string };
  request_ingestion: { id: string; title: string; receivedAt: string };
}
export type CapabilityHandlers = {
  [K in Capability]?: (context: OwnerContext) => Promise<CapabilityPayloads[K]>;
};
export interface IntegrationAdapter {
  readonly id: string;
  readonly name: string;
  readonly plannedCapabilities: readonly Capability[];
  readonly handlers: Readonly<CapabilityHandlers>;
  status(context: OwnerContext): ConnectionStatus;
  testConnection(context: OwnerContext): Promise<ConnectionStatus>;
}
export class IntegrationError extends Error {
  constructor(public readonly code: "not_found" | "disabled" | "unsupported" | "not_configured" | "unavailable") {
    super(code);
  }
}
