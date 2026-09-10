export const integrationIds = [
  "plex",
  "sonarr",
  "radarr",
  "prowlarr",
  "qbittorrent",
  "mpilot",
  "telegram",
] as const;

export type IntegrationId = (typeof integrationIds)[number];

export type IntegrationCapability =
  | "archive_search"
  | "media_lookup"
  | "host_lookup"
  | "missing_media_discovery"
  | "source_inspection"
  | "acquisition_job_creation"
  | "acquisition_job_status"
  | "media_inspection"
  | "media_verification"
  | "rename_move"
  | "library_scan";

export const integrationCapabilities: readonly IntegrationCapability[] = [
  "archive_search",
  "media_lookup",
  "host_lookup",
  "missing_media_discovery",
  "source_inspection",
  "acquisition_job_creation",
  "acquisition_job_status",
  "media_inspection",
  "media_verification",
  "rename_move",
  "library_scan",
];

export type IntegrationStatusState =
  | "disconnected"
  | "configured"
  | "reachable"
  | "operational"
  | "error";

export interface IntegrationStatus {
  id: IntegrationId;
  name: string;
  state: IntegrationStatusState;
  configured: boolean;
  reachable: boolean;
  operational: boolean;
  capabilities: readonly IntegrationCapability[];
  detail: string;
  lastCheckedAt: string | null;
}

export interface CapabilityContext {
  ownerId: string;
  signal?: AbortSignal;
}

export interface ArchiveSearchRequest {
  query: string;
  mediaType?: string;
}

export interface ArchiveSearchRecord {
  externalId: string;
  title: string;
  mediaType: string;
  year: number | null;
  source: IntegrationId;
  metadata?: Record<string, unknown>;
}

export interface ArchiveSearchResult {
  records: ArchiveSearchRecord[];
}

export interface MediaLookupRequest {
  query?: string;
  externalId?: string;
  mediaType?: string;
}

export interface MediaLookupResult {
  records: ArchiveSearchRecord[];
}

export interface HostLookupRequest {
  query: string;
}

export interface HostLookupResult {
  host: string;
  port: number | null;
  reachable: boolean;
  detail: string;
}

export interface MissingMediaDiscoveryRequest {
  mediaType?: string;
  query?: string;
}

export interface MissingMediaRecord {
  externalId: string;
  title: string;
  mediaType: string;
  year: number | null;
  detail?: string;
}

export interface MissingMediaDiscoveryResult {
  items: MissingMediaRecord[];
}

export interface SourceInspectionRequest {
  sourceId: string;
  location?: string;
}

export interface SourceInspectionResult {
  sourceId: string;
  available: boolean;
  title: string | null;
  detail: string;
  metadata?: Record<string, unknown>;
}

export interface AcquisitionJobRequest {
  mediaType: string;
  title: string;
  year?: number;
  externalId?: string;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface AcquisitionJobResult {
  accepted: boolean;
  jobId: string | null;
  status: "accepted" | "rejected" | "unavailable";
  detail: string;
}

export interface AcquisitionJobStatusRequest {
  jobId?: string;
  externalId?: string;
}

export interface AcquisitionJobStatus {
  jobId: string;
  status: string;
  progress: number | null;
  title: string | null;
  mediaType: string | null;
  detail: string;
  metadata?: Record<string, unknown>;
}

export interface AcquisitionJobStatusResult {
  jobs: AcquisitionJobStatus[];
}

export interface MediaInspectionRequest {
  externalId?: string;
  path?: string;
  title?: string;
}

export interface MediaInspectionResult {
  found: boolean;
  title: string | null;
  mediaType: string | null;
  detail: string;
  metadata?: Record<string, unknown>;
}

export interface MediaVerificationRequest {
  externalId?: string;
  path?: string;
}

export interface MediaVerificationResult {
  verified: boolean;
  detail: string;
  evidence: Record<string, unknown>;
}

export interface RenameMoveRequest {
  sourcePath: string;
  destinationPath: string;
  dryRun?: boolean;
}

export interface RenameMoveResult {
  changed: boolean;
  detail: string;
  path: string | null;
}

export interface LibraryScanRequest {
  libraryId?: string;
}

export interface LibraryScanResult {
  accepted: boolean;
  status: "queued" | "completed" | "failed";
  detail: string;
}

export interface CapabilityInputByName {
  archive_search: ArchiveSearchRequest;
  media_lookup: MediaLookupRequest;
  host_lookup: HostLookupRequest;
  missing_media_discovery: MissingMediaDiscoveryRequest;
  source_inspection: SourceInspectionRequest;
  acquisition_job_creation: AcquisitionJobRequest;
  acquisition_job_status: AcquisitionJobStatusRequest;
  media_inspection: MediaInspectionRequest;
  media_verification: MediaVerificationRequest;
  rename_move: RenameMoveRequest;
  library_scan: LibraryScanRequest;
}

export interface CapabilityResultByName {
  archive_search: ArchiveSearchResult;
  media_lookup: MediaLookupResult;
  host_lookup: HostLookupResult;
  missing_media_discovery: MissingMediaDiscoveryResult;
  source_inspection: SourceInspectionResult;
  acquisition_job_creation: AcquisitionJobResult;
  acquisition_job_status: AcquisitionJobStatusResult;
  media_inspection: MediaInspectionResult;
  media_verification: MediaVerificationResult;
  rename_move: RenameMoveResult;
  library_scan: LibraryScanResult;
}

export type CapabilityHandler<K extends IntegrationCapability> = (
  input: CapabilityInputByName[K],
  context: CapabilityContext,
) => Promise<CapabilityResultByName[K]>;

export type CapabilityHandlerMap = {
  [K in IntegrationCapability]: CapabilityHandler<K>;
};

export interface MediaIntegrationAdapter {
  readonly id: IntegrationId;
  readonly name: string;
  readonly capabilities: readonly IntegrationCapability[];
  getStatus(ownerId: string): Promise<IntegrationStatus>;
  getCapability<K extends IntegrationCapability>(
    capability: K,
  ): CapabilityHandler<K> | undefined;
}

export class IntegrationUnavailableError extends Error {
  readonly integrationId?: IntegrationId;
  readonly capability?: IntegrationCapability;

  constructor(
    message: string,
    details: {
      integrationId?: IntegrationId;
      capability?: IntegrationCapability;
    } = {},
  ) {
    super(message);
    this.name = "IntegrationUnavailableError";
    this.integrationId = details.integrationId;
    this.capability = details.capability;
  }
}