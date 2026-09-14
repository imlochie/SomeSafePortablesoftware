import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { moveFile } from "../lib/fs-move";
import { archiveDb, addEvent, readSettings } from "../lib/archive-db";
import { inspectLocalMedia, isPathWithin } from "./media";
import { findArchiveVolumeForPath, getArchiveScanRoots } from "./storage";
import { readReviewItem } from "./review-queue";
import { readAcquisitionJob } from "./acquisition-jobs";
import { getPlexConfig, syncPlexInventory } from "./plex";
import { readArchiveScan, startArchiveScan } from "./archive";
import { readReconciliationReport } from "./reconciliation";

export const archiveOperationActions = ["rename", "move", "import"] as const;
export type ArchiveOperationAction = (typeof archiveOperationActions)[number];
export const archiveOperationStatuses = [
  "planned",
  "preflight",
  "ready",
  "executing",
  "completed",
  "failed",
  "cancelled",
  "rolled_back",
] as const;
export type ArchiveOperationStatus = (typeof archiveOperationStatuses)[number];

export interface ArchiveOperationEvent {
  id: number;
  fromStatus: ArchiveOperationStatus | null;
  toStatus: ArchiveOperationStatus;
  detail: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ArchiveOperation {
  id: number;
  operationKey: string;
  action: ArchiveOperationAction;
  sourceKind: string;
  sourceId: string | null;
  sourcePath: string;
  destinationPath: string;
  reviewItemId: number;
  acquisitionJobId: number | null;
  downloadJobId: number | null;
  status: ArchiveOperationStatus;
  dryRun: boolean;
  retryCount: number;
  maxRetries: number;
  preflight: Record<string, unknown>;
  rollback: Record<string, unknown>;
  postflight: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
  events: ArchiveOperationEvent[];
}

export interface CreateArchiveOperationInput {
  action: ArchiveOperationAction;
  sourceKind: string;
  sourceId?: string | null;
  sourcePath: string;
  destinationPath: string;
  reviewItemId: number;
  acquisitionJobId?: number | null;
  downloadJobId?: number | null;
  dryRun?: boolean;
  idempotencyKey?: string;
}

export interface OperationDependencies {
  stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  access(path: string, mode?: number): Promise<void>;
  copyFile(source: string, destination: string, mode?: number): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
  inspect(path: string): Promise<Record<string, unknown>>;
}

function defaultDependencies(): OperationDependencies {
  const settings = readSettings();
  return {
    stat: (path) => fs.stat(path),
    access: (path, mode) => fs.access(path, mode),
    copyFile: (source, destination, mode) => fs.copyFile(source, destination, mode),
    rename: (source, destination) => moveFile(source, destination),
    unlink: (path) => fs.unlink(path),
    inspect: (path) => inspectLocalMedia(path, settings),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function json(value: unknown): Record<string, unknown> {
  try {
    return record(JSON.parse(String(value ?? "{}")));
  } catch {
    return {};
  }
}

function action(value: unknown): ArchiveOperationAction {
  if (typeof value === "string" && archiveOperationActions.includes(value as ArchiveOperationAction)) {
    return value as ArchiveOperationAction;
  }
  throw new Error("Archive operation action is not supported.");
}

function status(value: unknown): ArchiveOperationStatus {
  if (typeof value === "string" && archiveOperationStatuses.includes(value as ArchiveOperationStatus)) {
    return value as ArchiveOperationStatus;
  }
  return "planned";
}

function readEvents(id: number, ownerId: string): ArchiveOperationEvent[] {
  return (archiveDb.prepare(`
    SELECT id, from_status, to_status, detail, metadata_json, created_at
    FROM archive_operation_event
    WHERE operation_id = ? AND owner_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(id, ownerId) as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    fromStatus: row.from_status == null ? null : status(row.from_status),
    toStatus: status(row.to_status),
    detail: String(row.detail),
    metadata: json(row.metadata_json),
    createdAt: String(row.created_at),
  }));
}

function mapOperation(row: Record<string, unknown>, ownerId: string): ArchiveOperation {
  const id = Number(row.id);
  return {
    id,
    operationKey: String(row.operation_key),
    action: action(row.action),
    sourceKind: String(row.source_kind),
    sourceId: row.source_id == null ? null : String(row.source_id),
    sourcePath: String(row.source_path),
    destinationPath: String(row.destination_path),
    reviewItemId: Number(row.review_item_id),
    acquisitionJobId: row.acquisition_job_id == null ? null : Number(row.acquisition_job_id),
    downloadJobId: row.download_job_id == null ? null : Number(row.download_job_id),
    status: status(row.status),
    dryRun: Number(row.dry_run) === 1,
    retryCount: Number(row.retry_count),
    maxRetries: Number(row.max_retries),
    preflight: json(row.preflight_json),
    rollback: json(row.rollback_json),
    postflight: json(row.postflight_json),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: String(row.created_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
    updatedAt: String(row.updated_at),
    events: readEvents(id, ownerId),
  };
}

function appendEvent(
  operation: ArchiveOperation,
  ownerId: string,
  nextStatus: ArchiveOperationStatus,
  detail: string,
  metadata: Record<string, unknown> = {},
) {
  archiveDb.prepare(`
    INSERT INTO archive_operation_event
      (operation_id, owner_id, from_status, to_status, detail, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(operation.id, ownerId, operation.status, nextStatus, detail, JSON.stringify(metadata));
}

function updateOperation(
  id: number,
  ownerId: string,
  updates: Record<string, string | number | null>,
) {
  const entries = Object.entries(updates);
  if (!entries.length) return;
  archiveDb.prepare(`
    UPDATE archive_operation
    SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_id = ?
  `).run(...entries.map(([, value]) => value), id, ownerId);
}

async function waitForArchiveScan(ownerId: string) {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const scan = readArchiveScan(ownerId);
    if (scan.status !== "scanning") return scan;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Post-operation archive scan did not finish within 60 seconds.");
}

async function persistPostflight(operation: ArchiveOperation, ownerId: string) {
  const outcome: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    archiveScan: null,
    plex: { configured: false, attempted: false },
    reconciliation: null,
    errors: [],
  };
  const errors = outcome.errors as string[];
  try {
    startArchiveScan(ownerId);
    outcome.archiveScan = await waitForArchiveScan(ownerId);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Archive scan failed.");
  }
  try {
    const plex = getPlexConfig(ownerId);
    outcome.plex = {
      configured: plex.configured,
      attempted: plex.configured,
      status: plex.syncStatus,
      error: plex.lastError,
    };
    if (plex.configured) {
      await syncPlexInventory(ownerId);
      const refreshed = getPlexConfig(ownerId);
      outcome.plex = {
        configured: true,
        attempted: true,
        status: refreshed.syncStatus,
        error: refreshed.lastError,
        lastSuccessfulSyncAt: refreshed.lastSuccessfulSyncAt,
      };
      if (refreshed.syncStatus === "sync_error") {
        errors.push(refreshed.lastError ?? "Plex synchronization failed.");
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Plex refresh failed.");
  }
  try {
    outcome.reconciliation = await readReconciliationReport(ownerId, 1, 25);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Reconciliation failed.");
  }
  outcome.completedAt = new Date().toISOString();
  outcome.status = errors.length ? "completed_with_errors" : "completed";
  updateOperation(operation.id, ownerId, {
    postflight_json: JSON.stringify(outcome),
  });
  const updated = readArchiveOperation(operation.id, ownerId)!;
  appendEvent(
    updated,
    ownerId,
    "completed",
    errors.length
      ? "Post-operation refresh completed with recorded errors."
      : "Post-operation archive scan, Plex refresh, and reconciliation completed.",
    outcome,
  );
  if (updated.acquisitionJobId) {
    const row = archiveDb.prepare(
      "SELECT metadata_json FROM acquisition_job WHERE id = ? AND owner_id = ?",
    ).get(updated.acquisitionJobId, ownerId) as { metadata_json: string } | undefined;
    if (row) {
      archiveDb.prepare(`
        UPDATE acquisition_job
        SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND owner_id = ?
      `).run(JSON.stringify({
        ...json(row.metadata_json),
        importOperationId: updated.id,
        postImport: outcome,
      }), updated.acquisitionJobId, ownerId);
    }
  }
}

function operationKey(ownerId: string, input: CreateArchiveOperationInput) {
  if (input.idempotencyKey?.trim()) return input.idempotencyKey.trim();
  return createHash("sha256").update(JSON.stringify({
    ownerId,
    reviewItemId: input.reviewItemId,
    action: input.action,
    sourcePath: resolve(input.sourcePath),
    destinationPath: resolve(input.destinationPath),
  })).digest("hex");
}

export function readArchiveOperation(id: number, ownerId: string) {
  const row = archiveDb.prepare(
    "SELECT * FROM archive_operation WHERE id = ? AND owner_id = ?",
  ).get(id, ownerId) as Record<string, unknown> | undefined;
  return row ? mapOperation(row, ownerId) : null;
}

export function listArchiveOperations(
  ownerId: string,
  requestedStatus?: ArchiveOperationStatus,
) {
  const rows = requestedStatus
    ? archiveDb.prepare(`
      SELECT * FROM archive_operation WHERE owner_id = ? AND status = ?
      ORDER BY updated_at DESC, id DESC
    `).all(ownerId, requestedStatus)
    : archiveDb.prepare(`
      SELECT * FROM archive_operation WHERE owner_id = ?
      ORDER BY updated_at DESC, id DESC
    `).all(ownerId);
  return (rows as Array<Record<string, unknown>>).map((row) => mapOperation(row, ownerId));
}

export function createArchiveOperation(input: CreateArchiveOperationInput, ownerId: string) {
  const review = readReviewItem(input.reviewItemId, ownerId);
  if (!review) throw new Error("Approved review item not found.");
  if (review.state !== "approved") {
    throw new Error("Archive operations require an explicitly approved review item.");
  }
  if (input.acquisitionJobId && !readAcquisitionJob(input.acquisitionJobId, ownerId)) {
    throw new Error("Acquisition job not found for this owner.");
  }
  const sourcePath = resolve(input.sourcePath);
  const destinationPath = resolve(input.destinationPath);
  if (sourcePath === destinationPath) throw new Error("Source and destination paths must differ.");
  const key = operationKey(ownerId, { ...input, sourcePath, destinationPath });
  const existing = archiveDb.prepare(`
    SELECT * FROM archive_operation WHERE owner_id = ? AND operation_key = ?
  `).get(ownerId, key) as Record<string, unknown> | undefined;
  if (existing) return mapOperation(existing, ownerId);
  const result = archiveDb.prepare(`
    INSERT INTO archive_operation
      (owner_id, operation_key, action, source_kind, source_id, source_path,
       destination_path, review_item_id, acquisition_job_id, download_job_id, dry_run)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ownerId,
    key,
    input.action,
    input.sourceKind,
    input.sourceId ?? null,
    sourcePath,
    destinationPath,
    input.reviewItemId,
    input.acquisitionJobId ?? null,
    input.downloadJobId ?? null,
    input.dryRun ? 1 : 0,
  );
  const operation = readArchiveOperation(Number(result.lastInsertRowid), ownerId)!;
  appendEvent(operation, ownerId, "planned", "Approved archive operation planned.", {
    reviewItemId: review.id,
    dryRun: operation.dryRun,
  });
  addEvent("info", `Archive operation ${operation.id} planned.`, "archive-operations", ownerId);
  return readArchiveOperation(operation.id, ownerId)!;
}

function pathAllowed(path: string) {
  const settings = readSettings();
  return [
    settings.dataDirectory,
    settings.downloadDirectory,
    settings.temporaryDirectory,
    ...getArchiveScanRoots(settings),
  ].some((root) => root?.trim() && isPathWithin(path, root));
}

export async function preflightArchiveOperation(
  id: number,
  ownerId: string,
  dependencies: OperationDependencies = defaultDependencies(),
) {
  const operation = readArchiveOperation(id, ownerId);
  if (!operation) throw new Error("Archive operation not found.");
  if (!["planned", "failed", "ready"].includes(operation.status)) {
    throw new Error(`Cannot preflight an operation in ${operation.status} state.`);
  }
  const review = readReviewItem(operation.reviewItemId, ownerId);
  if (!review || review.state !== "approved") {
    throw new Error("The operation approval is no longer valid.");
  }
  updateOperation(id, ownerId, { status: "preflight", error_code: null, error_message: null });
  appendEvent(operation, ownerId, "preflight", "Archive operation preflight started.");
  try {
    if (!pathAllowed(operation.sourcePath)) {
      throw new Error("Source path is outside configured Archive Assistant directories.");
    }
    const settings = readSettings();
    const destinationVolume = findArchiveVolumeForPath(operation.destinationPath, settings);
    if (!destinationVolume) {
      throw new Error("Destination path is outside configured archive volumes.");
    }
    if (!destinationVolume.exists || !destinationVolume.writable) {
      throw new Error("Destination archive volume is unavailable or not writable.");
    }
    const source = await dependencies.stat(operation.sourcePath);
    if (!source.isFile()) throw new Error("Operation source is not a regular file.");
    await dependencies.access(dirname(operation.destinationPath), fsConstants.W_OK);
    let destinationExists = false;
    try {
      await dependencies.stat(operation.destinationPath);
      destinationExists = true;
    } catch {
      destinationExists = false;
    }
    if (destinationExists) throw new Error("Destination collision detected; overwrite is not allowed.");
    if (destinationVolume.freeBytes !== null && destinationVolume.freeBytes < source.size) {
      throw new Error("Destination volume does not have enough free space.");
    }
    const inspection = await dependencies.inspect(operation.sourcePath);
    const preflight = {
      sourceExists: true,
      sourceSizeBytes: source.size,
      destinationExists: false,
      destinationVolume: {
        id: destinationVolume.id,
        path: destinationVolume.path,
        freeBytes: destinationVolume.freeBytes,
      },
      inspection,
      approval: {
        reviewItemId: review.id,
        decidedBy: review.decidedBy,
        decisionAt: review.decisionAt,
      },
      checkedAt: new Date().toISOString(),
    };
    updateOperation(id, ownerId, {
      status: "ready",
      preflight_json: JSON.stringify(preflight),
    });
    const current = readArchiveOperation(id, ownerId)!;
    appendEvent(current, ownerId, "ready", "Preflight passed without changing files.", {
      sourceSizeBytes: source.size,
      destinationVolumeId: destinationVolume.id,
    });
    return readArchiveOperation(id, ownerId)!;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Operation preflight failed.";
    updateOperation(id, ownerId, {
      status: "failed",
      error_code: "PREFLIGHT_FAILED",
      error_message: message,
    });
    const current = readArchiveOperation(id, ownerId)!;
    appendEvent(current, ownerId, "failed", message, { phase: "preflight" });
    addEvent("error", `Archive operation ${id} preflight failed: ${message}`, "archive-operations", ownerId);
    return readArchiveOperation(id, ownerId)!;
  }
}

async function verifyDestination(
  operation: ArchiveOperation,
  expectedSize: number,
  dependencies: OperationDependencies,
) {
  const destination = await dependencies.stat(operation.destinationPath);
  if (!destination.isFile() || destination.size !== expectedSize) {
    throw new Error("Destination verification failed after filesystem operation.");
  }
}

export async function executeArchiveOperation(
  id: number,
  ownerId: string,
  confirmed: boolean,
  dependencies: OperationDependencies = defaultDependencies(),
) {
  if (!confirmed) throw new Error("Explicit operation confirmation is required.");
  let operation = readArchiveOperation(id, ownerId);
  if (!operation) throw new Error("Archive operation not found.");
  if (operation.status === "completed" || operation.status === "rolled_back") return operation;
  if (operation.status !== "ready") {
    operation = await preflightArchiveOperation(id, ownerId, dependencies);
  }
  if (operation.status !== "ready") return operation;
  if (operation.dryRun) {
    appendEvent(operation, ownerId, "ready", "Dry run completed; no filesystem mutation was performed.");
    return readArchiveOperation(id, ownerId)!;
  }
  const review = readReviewItem(operation.reviewItemId, ownerId);
  if (!review || review.state !== "approved") {
    throw new Error("The approved review item is required at execution time.");
  }
  const sourceSize = Number(operation.preflight.sourceSizeBytes);
  updateOperation(id, ownerId, {
    status: "executing",
    started_at: new Date().toISOString(),
    error_code: null,
    error_message: null,
  });
  operation = readArchiveOperation(id, ownerId)!;
  appendEvent(operation, ownerId, "executing", "Filesystem operation started after explicit confirmation.");
  let destinationCreated = false;
  try {
    if (operation.action === "rename") {
      await dependencies.rename(operation.sourcePath, operation.destinationPath);
      destinationCreated = true;
    } else {
      await dependencies.copyFile(
        operation.sourcePath,
        operation.destinationPath,
        fsConstants.COPYFILE_EXCL,
      );
      destinationCreated = true;
      await verifyDestination(operation, sourceSize, dependencies);
      if (operation.action === "move") await dependencies.unlink(operation.sourcePath);
    }
    await verifyDestination(operation, sourceSize, dependencies);
    const rollback = {
      supported: true,
      action: operation.action === "import" ? "remove_imported_copy" : "restore_source_path",
      sourcePath: operation.sourcePath,
      destinationPath: operation.destinationPath,
      sourceSizeBytes: sourceSize,
      createdAt: new Date().toISOString(),
    };
    updateOperation(id, ownerId, {
      status: "completed",
      rollback_json: JSON.stringify(rollback),
      completed_at: new Date().toISOString(),
    });
    const completed = readArchiveOperation(id, ownerId)!;
    appendEvent(completed, ownerId, "completed", "Filesystem operation completed and destination was verified.", {
      rollback,
    });
    addEvent("success", `Archive operation ${id} completed.`, "archive-operations", ownerId);
    await persistPostflight(completed, ownerId);
    return readArchiveOperation(id, ownerId)!;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Filesystem operation failed.";
    if (destinationCreated && operation.action !== "rename") {
      try {
        await dependencies.unlink(operation.destinationPath);
        destinationCreated = false;
      } catch {
        // Preserve the failure and record that manual recovery may be required.
      }
    }
    updateOperation(id, ownerId, {
      status: "failed",
      error_code: "EXECUTION_FAILED",
      error_message: message,
      rollback_json: JSON.stringify({
        supported: true,
        destinationCreated,
        sourcePath: operation.sourcePath,
        destinationPath: operation.destinationPath,
        recoveryRequired: destinationCreated,
      }),
    });
    const failed = readArchiveOperation(id, ownerId)!;
    appendEvent(failed, ownerId, "failed", message, {
      phase: "execution",
      destinationCreated,
    });
    addEvent("error", `Archive operation ${id} failed: ${message}`, "archive-operations", ownerId);
    return readArchiveOperation(id, ownerId)!;
  }
}

export function cancelArchiveOperation(id: number, ownerId: string) {
  const operation = readArchiveOperation(id, ownerId);
  if (!operation) throw new Error("Archive operation not found.");
  if (operation.status === "cancelled") return operation;
  if (["executing", "completed", "rolled_back"].includes(operation.status)) {
    throw new Error(`Cannot cancel an operation in ${operation.status} state.`);
  }
  updateOperation(id, ownerId, {
    status: "cancelled",
    cancelled_at: new Date().toISOString(),
  });
  appendEvent(operation, ownerId, "cancelled", "Archive operation cancelled before filesystem execution.");
  addEvent("info", `Archive operation ${id} cancelled.`, "archive-operations", ownerId);
  return readArchiveOperation(id, ownerId)!;
}

export async function retryArchiveOperation(
  id: number,
  ownerId: string,
  dependencies: OperationDependencies = defaultDependencies(),
) {
  const operation = readArchiveOperation(id, ownerId);
  if (!operation) throw new Error("Archive operation not found.");
  if (!["failed", "cancelled"].includes(operation.status)) {
    throw new Error("Only failed or cancelled archive operations can be retried.");
  }
  if (operation.retryCount >= operation.maxRetries) {
    throw new Error("Archive operation retry limit has been reached.");
  }
  updateOperation(id, ownerId, {
    status: "planned",
    retry_count: operation.retryCount + 1,
    error_code: null,
    error_message: null,
    cancelled_at: null,
  });
  const planned = readArchiveOperation(id, ownerId)!;
  appendEvent(planned, ownerId, "planned", "Archive operation retry planned.", {
    retryCount: planned.retryCount,
  });
  return preflightArchiveOperation(id, ownerId, dependencies);
}

export async function rollbackArchiveOperation(
  id: number,
  ownerId: string,
  confirmed: boolean,
  dependencies: OperationDependencies = defaultDependencies(),
) {
  if (!confirmed) throw new Error("Explicit rollback confirmation is required.");
  const operation = readArchiveOperation(id, ownerId);
  if (!operation) throw new Error("Archive operation not found.");
  if (operation.status === "rolled_back") return operation;
  if (operation.status !== "completed") throw new Error("Only completed operations can be rolled back.");
  if (operation.action === "import") {
    await dependencies.unlink(operation.destinationPath);
  } else {
    try {
      await dependencies.stat(operation.sourcePath);
      throw new Error("Rollback collision detected at the original source path.");
    } catch (error) {
      if (error instanceof Error && error.message.includes("Rollback collision")) throw error;
    }
    await dependencies.rename(operation.destinationPath, operation.sourcePath);
  }
  updateOperation(id, ownerId, { status: "rolled_back" });
  appendEvent(operation, ownerId, "rolled_back", "Explicit rollback completed.", {
    rollback: operation.rollback,
  });
  addEvent("warning", `Archive operation ${id} was rolled back.`, "archive-operations", ownerId);
  return readArchiveOperation(id, ownerId)!;
}