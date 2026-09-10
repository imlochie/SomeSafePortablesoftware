import {
  IntegrationUnavailableError,
  integrationRegistry,
  type IntegrationId,
} from "../integrations";
import { archiveDb, addEvent } from "../lib/archive-db";

export const acquisitionJobStates = [
  "planned",
  "searching",
  "source_selected",
  "downloading",
  "processing",
  "verifying",
  "importing",
  "complete",
  "failed",
  "cancelled",
] as const;

export type AcquisitionJobState = (typeof acquisitionJobStates)[number];
export type AcquisitionProviderId = "sonarr" | "radarr" | "prowlarr" | "qbittorrent";

const providerIds = new Set<AcquisitionProviderId>([
  "sonarr",
  "radarr",
  "prowlarr",
  "qbittorrent",
]);

const transitions: Record<AcquisitionJobState, readonly AcquisitionJobState[]> = {
  planned: ["searching", "source_selected", "downloading", "failed", "cancelled"],
  searching: ["source_selected", "downloading", "failed", "cancelled"],
  source_selected: ["downloading", "failed", "cancelled"],
  downloading: ["processing", "failed", "cancelled"],
  processing: ["verifying", "failed", "cancelled"],
  verifying: ["importing", "failed", "cancelled"],
  importing: ["complete", "failed", "cancelled"],
  complete: [],
  failed: ["cancelled"],
  cancelled: [],
};

const phaseTimestamp: Partial<Record<AcquisitionJobState, string>> = {
  planned: "planned_at",
  searching: "searching_at",
  source_selected: "source_selected_at",
  downloading: "downloading_at",
  processing: "processing_at",
  verifying: "verifying_at",
  importing: "importing_at",
  complete: "completed_at",
  failed: "failed_at",
  cancelled: "cancelled_at",
};

const stateRank: Record<AcquisitionJobState, number> = {
  planned: 0,
  searching: 1,
  source_selected: 2,
  downloading: 3,
  processing: 4,
  verifying: 5,
  importing: 6,
  complete: 7,
  failed: -1,
  cancelled: -1,
};

export interface CreateAcquisitionJobInput {
  mediaType: string;
  title: string;
  year?: number | null;
  externalId?: string | null;
  sourceId?: string | null;
  sourceUrl?: string | null;
  providerId?: AcquisitionProviderId | null;
  metadata?: Record<string, unknown>;
  start?: boolean;
}

export interface ProgressAcquisitionJobInput {
  state: AcquisitionJobState;
  progress?: number;
  providerJobId?: string | null;
  providerReference?: string | null;
  metadata?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
  detail?: string;
}

export interface AcquisitionJobEvent {
  id: number;
  fromState: AcquisitionJobState | null;
  toState: AcquisitionJobState;
  detail: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AcquisitionJob {
  id: number;
  ownerId: string;
  mediaType: string;
  title: string;
  year: number | null;
  externalId: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  providerId: AcquisitionProviderId | null;
  providerJobId: string | null;
  providerReference: string | null;
  downloadJobId: number | null;
  state: AcquisitionJobState;
  progress: number;
  retryCount: number;
  maxRetries: number;
  errorCode: string | null;
  errorMessage: string | null;
  request: Record<string, unknown>;
  metadata: Record<string, unknown>;
  plannedAt: string;
  searchingAt: string | null;
  sourceSelectedAt: string | null;
  downloadingAt: string | null;
  processingAt: string | null;
  verifyingAt: string | null;
  importingAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  events: AcquisitionJobEvent[];
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function state(value: unknown): AcquisitionJobState {
  if (typeof value === "string" && (acquisitionJobStates as readonly string[]).includes(value)) {
    return value as AcquisitionJobState;
  }
  return "planned";
}

function provider(value: unknown): AcquisitionProviderId | null {
  return typeof value === "string" && providerIds.has(value as AcquisitionProviderId)
    ? value as AcquisitionProviderId
    : null;
}

function toEvent(row: Record<string, unknown>): AcquisitionJobEvent {
  return {
    id: Number(row.id),
    fromState: row.from_state == null ? null : state(row.from_state),
    toState: state(row.to_state),
    detail: String(row.detail ?? ""),
    metadata: parseJson(row.metadata_json),
    createdAt: String(row.created_at),
  };
}

function toJob(row: Record<string, unknown>, events: AcquisitionJobEvent[] = []): AcquisitionJob {
  return {
    id: Number(row.id),
    ownerId: String(row.owner_id),
    mediaType: String(row.media_type),
    title: String(row.title),
    year: row.year == null ? null : Number(row.year),
    externalId: row.external_id == null ? null : String(row.external_id),
    sourceId: row.source_id == null ? null : String(row.source_id),
    sourceUrl: row.source_url == null ? null : String(row.source_url),
    providerId: provider(row.provider_id),
    providerJobId: row.provider_job_id == null ? null : String(row.provider_job_id),
    providerReference: row.provider_reference == null ? null : String(row.provider_reference),
    downloadJobId: row.download_job_id == null ? null : Number(row.download_job_id),
    state: state(row.state),
    progress: Number(row.progress ?? 0),
    retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? 3),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    request: parseJson(row.request_json),
    metadata: parseJson(row.metadata_json),
    plannedAt: String(row.planned_at),
    searchingAt: row.searching_at == null ? null : String(row.searching_at),
    sourceSelectedAt: row.source_selected_at == null ? null : String(row.source_selected_at),
    downloadingAt: row.downloading_at == null ? null : String(row.downloading_at),
    processingAt: row.processing_at == null ? null : String(row.processing_at),
    verifyingAt: row.verifying_at == null ? null : String(row.verifying_at),
    importingAt: row.importing_at == null ? null : String(row.importing_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    failedAt: row.failed_at == null ? null : String(row.failed_at),
    cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    events,
  };
}

function readEvents(id: number, ownerId: string) {
  return (archiveDb.prepare(`
    SELECT id, from_state, to_state, detail, metadata_json, created_at
    FROM acquisition_job_event
    WHERE acquisition_job_id = ? AND owner_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(id, ownerId) as Array<Record<string, unknown>>).map(toEvent);
}

export function readAcquisitionJob(id: number, ownerId: string) {
  const row = archiveDb.prepare(`
    SELECT * FROM acquisition_job WHERE id = ? AND owner_id = ?
  `).get(id, ownerId) as Record<string, unknown> | undefined;
  return row ? toJob(row, readEvents(id, ownerId)) : null;
}

export function listAcquisitionJobs(
  ownerId: string,
  requestedState?: AcquisitionJobState,
) {
  const rows = requestedState
    ? archiveDb.prepare(`
      SELECT * FROM acquisition_job
      WHERE owner_id = ? AND state = ?
      ORDER BY updated_at DESC, id DESC
    `).all(ownerId, requestedState)
    : archiveDb.prepare(`
      SELECT * FROM acquisition_job
      WHERE owner_id = ?
      ORDER BY updated_at DESC, id DESC
    `).all(ownerId);
  return (rows as Array<Record<string, unknown>>).map((row) =>
    toJob(row, readEvents(Number(row.id), ownerId)));
}

function updateJob(
  id: number,
  ownerId: string,
  updates: Record<string, string | number | null>,
) {
  const entries = Object.entries(updates);
  if (!entries.length) return;
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  const result = archiveDb.prepare(`
    UPDATE acquisition_job
    SET ${set}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_id = ?
  `).run(...entries.map(([, value]) => value), id, ownerId);
  if (result.changes === 0) throw new Error("Acquisition job not found.");
}

function addJobEvent(
  id: number,
  ownerId: string,
  fromState: AcquisitionJobState | null,
  toState: AcquisitionJobState,
  detail: string,
  metadata: Record<string, unknown> = {},
) {
  archiveDb.prepare(`
    INSERT INTO acquisition_job_event
      (acquisition_job_id, owner_id, from_state, to_state, detail, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, ownerId, fromState, toState, detail, JSON.stringify(metadata));
}

function progressValue(value: number | undefined) {
  if (value == null) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error("Acquisition job progress must be between 0 and 100.");
  }
  return value;
}

function transition(
  job: AcquisitionJob,
  ownerId: string,
  nextState: AcquisitionJobState,
  updates: Record<string, string | number | null> = {},
  detail = `Acquisition job moved to ${nextState}.`,
  metadata: Record<string, unknown> = {},
) {
  if (job.state !== nextState && !transitions[job.state].includes(nextState)) {
    throw new Error(`Cannot move an acquisition job from ${job.state} to ${nextState}.`);
  }
  const timestampColumn = phaseTimestamp[nextState];
  updateJob(job.id, ownerId, {
    state: nextState,
    current_phase: nextState,
    ...(timestampColumn ? { [timestampColumn]: new Date().toISOString() } : {}),
    ...updates,
  });
  addJobEvent(job.id, ownerId, job.state, nextState, detail, metadata);
  return readAcquisitionJob(job.id, ownerId);
}

function providerFor(input: CreateAcquisitionJobInput) {
  if (input.providerId) return input.providerId;
  if (input.mediaType === "movie" || input.mediaType === "film") return "radarr" as const;
  if (input.mediaType === "series" || input.mediaType === "tv" || input.mediaType === "episode") {
    return "sonarr" as const;
  }
  if (input.sourceId?.startsWith("magnet:") || input.sourceUrl?.startsWith("magnet:")) {
    return "qbittorrent" as const;
  }
  return null;
}

function errorCode(error: unknown) {
  if (error instanceof IntegrationUnavailableError) return "PROVIDER_UNAVAILABLE";
  if (error instanceof Error && error.name === "IntegrationHttpError") return "PROVIDER_REQUEST_FAILED";
  return "PROVIDER_REQUEST_FAILED";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The provider request failed.";
}

async function startProvider(job: AcquisitionJob, ownerId: string) {
  const providerId = job.providerId;
  if (!providerId) return job;

  try {
    const initialState: AcquisitionJobState = providerId === "qbittorrent"
      ? "source_selected"
      : "searching";
    let current = transition(
      job,
      ownerId,
      initialState,
      { error_code: null, error_message: null },
      providerId === "qbittorrent"
        ? "A source was selected for the provider download request."
        : `Sent the acquisition request to ${providerId}.`,
    );
    if (!current) throw new Error("Acquisition job disappeared after transition.");

    const result = await integrationRegistry.invoke(
      "acquisition_job_creation",
      {
        mediaType: current.mediaType,
        title: current.title,
        year: current.year ?? undefined,
        externalId: current.externalId ?? undefined,
        sourceId: current.sourceId ?? current.sourceUrl ?? undefined,
        metadata: current.metadata,
      },
      { ownerId },
      providerId as IntegrationId,
    );
    const nextState: AcquisitionJobState = providerId === "qbittorrent"
      ? "downloading"
      : "searching";
    current = transition(
      current,
      ownerId,
      nextState,
      {
        provider_job_id: result.jobId,
        provider_reference: result.detail,
        progress: nextState === "searching" ? 5 : 10,
      },
      result.detail,
      { providerStatus: result.status },
    );
    return current;
  } catch (error) {
    const current = readAcquisitionJob(job.id, ownerId);
    if (!current) throw error;
    updateJob(current.id, ownerId, {
      state: "failed",
      current_phase: "failed",
      failed_at: new Date().toISOString(),
      error_code: errorCode(error),
      error_message: errorMessage(error),
    });
    addJobEvent(current.id, ownerId, current.state, "failed", errorMessage(error), {
      errorCode: errorCode(error),
    });
    return readAcquisitionJob(current.id, ownerId);
  }
}

export async function createAcquisitionJob(
  input: CreateAcquisitionJobInput,
  ownerId: string,
) {
  if (!input.mediaType.trim()) throw new Error("Media type is required.");
  if (!input.title.trim()) throw new Error("Title is required.");
  const selectedProvider = input.providerId ?? (input.start ? providerFor(input) : null);
  const result = archiveDb.prepare(`
    INSERT INTO acquisition_job
      (owner_id, media_type, title, year, external_id, source_id, source_url,
       provider_id, state, progress, request_json, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', 0, ?, ?)
  `).run(
    ownerId,
    input.mediaType,
    input.title,
    input.year ?? null,
    input.externalId ?? null,
    input.sourceId ?? null,
    input.sourceUrl ?? null,
    selectedProvider,
    JSON.stringify(input),
    JSON.stringify(input.metadata ?? {}),
  );
  const id = Number(result.lastInsertRowid);
  addJobEvent(id, ownerId, null, "planned", "Acquisition request planned.", {
    providerId: selectedProvider,
  });
  const job = readAcquisitionJob(id, ownerId);
  if (!job) throw new Error("Acquisition job could not be read after creation.");
  if (input.start) return startProvider(job, ownerId);
  return job;
}

export async function retryAcquisitionJob(id: number, ownerId: string) {
  const job = readAcquisitionJob(id, ownerId);
  if (!job) throw new Error("Acquisition job not found.");
  if (!["failed", "cancelled"].includes(job.state)) {
    throw new Error("Only failed or cancelled acquisition jobs can be retried.");
  }
  if (job.retryCount >= job.maxRetries) {
    throw new Error("Acquisition job retry limit has been reached.");
  }
  const now = new Date().toISOString();
  updateJob(id, ownerId, {
    state: "planned",
    current_phase: "planned",
    progress: 0,
    retry_count: job.retryCount + 1,
    error_code: null,
    error_message: null,
    failed_at: null,
    cancelled_at: null,
    planned_at: now,
    searching_at: null,
    source_selected_at: null,
    downloading_at: null,
    processing_at: null,
    verifying_at: null,
    importing_at: null,
    completed_at: null,
  });
  addJobEvent(id, ownerId, job.state, "planned", "Acquisition retry planned.", {
    retryCount: job.retryCount + 1,
  });
  const reset = readAcquisitionJob(id, ownerId);
  if (!reset) throw new Error("Acquisition job not found after retry.");
  return reset.providerId ? startProvider(reset, ownerId) : reset;
}

export function cancelAcquisitionJob(id: number, ownerId: string) {
  const job = readAcquisitionJob(id, ownerId);
  if (!job) throw new Error("Acquisition job not found.");
  if (job.state === "complete") throw new Error("Completed acquisition jobs cannot be cancelled.");
  if (job.state === "cancelled") return job;
  const cancelled = transition(
    job,
    ownerId,
    "cancelled",
    { error_code: "CANCELLED", error_message: null },
    "Acquisition tracking was cancelled. No local filesystem changes were made.",
  );
  if (!cancelled) throw new Error("Acquisition job not found after cancellation.");
  return cancelled;
}

export function progressAcquisitionJob(
  id: number,
  ownerId: string,
  input: ProgressAcquisitionJobInput,
) {
  const job = readAcquisitionJob(id, ownerId);
  if (!job) throw new Error("Acquisition job not found.");
  const progress = progressValue(input.progress);
  const updates: Record<string, string | number | null> = {
    ...(progress === undefined ? {} : { progress }),
    ...(input.providerJobId === undefined ? {} : { provider_job_id: input.providerJobId }),
    ...(input.providerReference === undefined ? {} : { provider_reference: input.providerReference }),
    ...(input.errorCode === undefined ? {} : { error_code: input.errorCode }),
    ...(input.errorMessage === undefined ? {} : { error_message: input.errorMessage }),
  };
  if (input.metadata) {
    updates.metadata_json = JSON.stringify({ ...job.metadata, ...input.metadata });
  }
  const progressed = transition(
    job,
    ownerId,
    input.state,
    updates,
    input.detail ?? `Acquisition job moved to ${input.state}.`,
    input.metadata,
  );
  if (!progressed) throw new Error("Acquisition job not found after progression.");
  return progressed;
}

function stateFromProvider(providerId: AcquisitionProviderId, status: string, progress: number | null): AcquisitionJobState {
  const normalized = status.toLowerCase();
  if (providerId === "qbittorrent") {
    if (["uploading", "stalledup", "queuedup", "checkingup"].includes(normalized)) return "processing";
    if (["pausedup", "missingfiles"].includes(normalized)) return "failed";
    return progress !== null && progress >= 1 ? "processing" : "downloading";
  }
  if (normalized.includes("import") || normalized.includes("completed")) return "processing";
  if (normalized.includes("download")) return "downloading";
  return "searching";
}

export async function refreshAcquisitionJob(id: number, ownerId: string) {
  const job = readAcquisitionJob(id, ownerId);
  if (!job) throw new Error("Acquisition job not found.");
  if (!job.providerId || !job.providerJobId) {
    throw new Error("This acquisition job has no provider job reference to refresh.");
  }
  const result = await integrationRegistry.invoke(
    "acquisition_job_status",
    { jobId: job.providerJobId, externalId: job.externalId ?? undefined },
    { ownerId },
    job.providerId as IntegrationId,
  );
  const providerJob = result.jobs.find((candidate) => candidate.jobId === job.providerJobId)
    ?? result.jobs[0];
  if (!providerJob) {
    addJobEvent(id, ownerId, job.state, job.state, "Provider returned no matching job.", {
      providerJobId: job.providerJobId,
    });
    return readAcquisitionJob(id, ownerId);
  }
  const nextState = stateFromProvider(job.providerId, providerJob.status, providerJob.progress);
  const providerProgress = providerJob.progress == null ? undefined : providerJob.progress * 100;
  const mergedMetadata = {
    ...job.metadata,
    providerStatus: providerJob.status,
    ...(providerJob.metadata ?? {}),
  };
  if (nextState === "failed") {
    updateJob(id, ownerId, {
      state: "failed",
      current_phase: "failed",
      failed_at: new Date().toISOString(),
      error_code: "PROVIDER_REPORTED_FAILURE",
      error_message: providerJob.detail,
      ...(providerProgress === undefined ? {} : { progress: providerProgress }),
      metadata_json: JSON.stringify(mergedMetadata),
      provider_reference: providerJob.detail,
    });
    addJobEvent(id, ownerId, job.state, "failed", providerJob.detail, { providerStatus: providerJob.status });
    return readAcquisitionJob(id, ownerId);
  }
  if (stateRank[nextState] >= stateRank[job.state] && nextState !== job.state) {
    return progressAcquisitionJob(id, ownerId, {
      state: nextState,
      progress: providerProgress,
      providerReference: providerJob.detail,
      metadata: mergedMetadata,
      detail: `Provider reports ${providerJob.status}.`,
    });
  }
  updateJob(id, ownerId, {
    ...(providerProgress === undefined ? {} : { progress: providerProgress }),
    provider_reference: providerJob.detail,
    metadata_json: JSON.stringify(mergedMetadata),
  });
  addJobEvent(id, ownerId, job.state, job.state, `Provider reports ${providerJob.status}.`, {
    providerStatus: providerJob.status,
  });
  return readAcquisitionJob(id, ownerId);
}

export function isAcquisitionJobState(value: unknown): value is AcquisitionJobState {
  return typeof value === "string"
    && (acquisitionJobStates as readonly string[]).includes(value);
}

export function isAcquisitionProviderId(value: unknown): value is AcquisitionProviderId {
  return typeof value === "string" && providerIds.has(value as AcquisitionProviderId);
}