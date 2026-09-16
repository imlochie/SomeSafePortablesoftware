/**
 * Archive operations — compatibility layer over the Universal Action Engine.
 *
 * This module keeps the original `/api/archive-operations` contract (single
 * source → destination operations linked to an approved review item) but owns
 * no execution logic. Every operation is an ActionProposal with exactly one
 * ActionStep, so legacy operations and new action families share one
 * preflight/execute/verify/history/revert path.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { archiveDb } from "../lib/archive-db";
import { readReviewItem } from "./review-queue";
import { readAcquisitionJob } from "./acquisition-jobs";
import {
  cancelActionProposal,
  createActionProposal,
  defaultActionDependencies,
  executeActionProposal,
  listActionProposals,
  preflightActionProposal,
  readActionProposal,
  requireActionProposal,
  retryActionProposal,
  revertActionProposal,
  type ActionDependencies,
  type ActionProposal,
  type ActionProposalStatus,
  type ActionStep,
} from "./action-engine";

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

/** Legacy dependency seam; the engine adds mkdir/rmdir, defaulted here. */
export interface OperationDependencies {
  stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  access(path: string, mode?: number): Promise<void>;
  copyFile(source: string, destination: string, mode?: number): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
  inspect(path: string): Promise<Record<string, unknown>>;
}

function toActionDependencies(dependencies?: OperationDependencies): ActionDependencies {
  const base = defaultActionDependencies();
  if (!dependencies) return base;
  return { ...base, ...dependencies };
}

/**
 * Legacy operations expose a single status enum. Multi-step engine states are
 * projected onto it; one-step proposals map exactly.
 */
function toOperationStatus(proposal: ActionProposal): ArchiveOperationStatus {
  switch (proposal.status) {
    case "draft":
    case "proposed":
    case "approved":
      return "planned";
    case "preflight":
      return "preflight";
    case "ready":
      return "ready";
    case "executing":
      return "executing";
    case "completed":
      return "completed";
    case "partially_completed":
      return "failed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "reverted":
      return "rolled_back";
    default:
      return "planned";
  }
}

function toEventStatus(value: string | null): ArchiveOperationStatus | null {
  if (value == null) return null;
  const mapped: Record<string, ArchiveOperationStatus> = {
    draft: "planned",
    proposed: "planned",
    approved: "planned",
    preflight: "preflight",
    ready: "ready",
    executing: "executing",
    completed: "completed",
    partially_completed: "failed",
    failed: "failed",
    cancelled: "cancelled",
    reverted: "rolled_back",
    // Step-level statuses surface through the same history stream.
    pending: "planned",
    skipped: "planned",
    reverted_step: "rolled_back",
  };
  return mapped[value] ?? null;
}

function requireAction(value: string): ArchiveOperationAction {
  if (!(archiveOperationActions as readonly string[]).includes(value)) {
    throw new Error("Archive operation action is not supported.");
  }
  return value as ArchiveOperationAction;
}

function primaryStep(proposal: ActionProposal): ActionStep {
  const step = proposal.steps[0];
  if (!step) throw new Error("Archive operation is missing its action step.");
  return step;
}

function mapProposal(proposal: ActionProposal): ArchiveOperation {
  const step = primaryStep(proposal);
  const legacy = proposal.evidence.legacyOperation as Record<string, unknown> | undefined;
  const status = toOperationStatus(proposal);
  const rollback = step.status === "completed" || step.status === "reverted"
    ? {
      supported: true,
      action: step.type === "import" ? "remove_imported_copy" : "restore_source_path",
      sourcePath: String(step.before.path ?? ""),
      destinationPath: String(step.after.path ?? ""),
      sourceSizeBytes: step.preflight.sourceSizeBytes ?? null,
      ...step.revert,
    }
    : proposal.status === "failed" && step.status === "failed"
      ? {
        supported: true,
        destinationCreated: Boolean(step.execution.destinationPath),
        sourcePath: String(step.before.path ?? ""),
        destinationPath: String(step.after.path ?? ""),
        recoveryRequired: Boolean(step.execution.destinationPath),
      }
      : {};

  return {
    id: proposal.id,
    operationKey: String(legacy?.operationKey ?? proposal.proposalKey),
    action: requireAction(step.type),
    sourceKind: String(legacy?.sourceKind ?? "archive"),
    sourceId: legacy?.sourceId == null ? null : String(legacy.sourceId),
    sourcePath: String(step.before.path ?? ""),
    destinationPath: String(step.after.path ?? ""),
    reviewItemId: Number(proposal.reviewItemId ?? 0),
    acquisitionJobId: proposal.acquisitionJobId,
    downloadJobId: proposal.downloadJobId,
    status,
    dryRun: proposal.dryRun,
    retryCount: proposal.retryCount,
    maxRetries: proposal.maxRetries,
    // Legacy clients read a flat preflight object, not the per-step array.
    preflight: step.preflight,
    rollback,
    postflight: proposal.postflight,
    // A single-step operation reports the precise cause, not the aggregate.
    errorCode: step.errorCode ?? proposal.errorCode,
    errorMessage: step.errorMessage ?? proposal.errorMessage,
    createdAt: proposal.createdAt,
    startedAt: proposal.executedAt,
    completedAt: proposal.completedAt,
    cancelledAt: proposal.cancelledAt,
    updatedAt: proposal.updatedAt,
    events: proposal.events
      .map((event) => ({
        id: event.id,
        fromStatus: toEventStatus(event.fromStatus),
        toStatus: toEventStatus(event.toStatus) ?? status,
        detail: event.detail,
        metadata: event.metadata,
        createdAt: event.createdAt,
      })),
  };
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

/** Only proposals created through this adapter are legacy operations. */
function isLegacyOperation(proposal: ActionProposal) {
  return proposal.source === "operator"
    && proposal.steps.length === 1
    && Boolean((proposal.evidence.legacyOperation as Record<string, unknown> | undefined)?.operationKey);
}

export function readArchiveOperation(id: number, ownerId: string): ArchiveOperation | null {
  const proposal = readActionProposal(id, ownerId);
  if (!proposal || !isLegacyOperation(proposal)) return null;
  return mapProposal(proposal);
}

export function listArchiveOperations(
  ownerId: string,
  requestedStatus?: ArchiveOperationStatus,
): ArchiveOperation[] {
  return listActionProposals(ownerId, { source: "operator" })
    .filter(isLegacyOperation)
    .map(mapProposal)
    .filter((operation) => !requestedStatus || operation.status === requestedStatus);
}

export function createArchiveOperation(
  input: CreateArchiveOperationInput,
  ownerId: string,
): ArchiveOperation {
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
  const proposal = createActionProposal(ownerId, {
    type: input.action,
    source: "operator",
    reason: `${input.action} ${sourcePath} → ${destinationPath}`,
    reviewItemId: review.id,
    preApproved: true,
    dryRun: input.dryRun ?? false,
    acquisitionJobId: input.acquisitionJobId ?? null,
    downloadJobId: input.downloadJobId ?? null,
    idempotencyKey: `legacy-operation:${key}`,
    target: {
      kind: input.sourceKind,
      id: input.sourceId ?? null,
      path: sourcePath,
      label: null,
    },
    evidence: {
      legacyOperation: {
        operationKey: key,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId ?? null,
      },
      approval: {
        reviewItemId: review.id,
        decidedBy: review.decidedBy,
        decisionAt: review.decisionAt,
      },
    },
    steps: [{
      type: input.action,
      summary: `${input.action}: ${sourcePath} → ${destinationPath}`,
      target: {
        kind: input.sourceKind,
        id: input.sourceId ?? null,
        path: sourcePath,
        label: null,
      },
      before: { path: sourcePath },
      after: { path: destinationPath },
    }],
  });
  return mapProposal(requireActionProposal(proposal.id, ownerId));
}

function ensureLegacy(id: number, ownerId: string) {
  const proposal = readActionProposal(id, ownerId);
  if (!proposal || !isLegacyOperation(proposal)) throw new Error("Archive operation not found.");
  return proposal;
}

export async function preflightArchiveOperation(
  id: number,
  ownerId: string,
  dependencies?: OperationDependencies,
): Promise<ArchiveOperation> {
  const existing = ensureLegacy(id, ownerId);
  const status = toOperationStatus(existing);
  if (!["planned", "failed", "ready"].includes(status)) {
    throw new Error(`Cannot preflight an operation in ${status} state.`);
  }
  if (existing.reviewItemId !== null) {
    const review = readReviewItem(existing.reviewItemId, ownerId);
    if (!review || review.state !== "approved") {
      throw new Error("The operation approval is no longer valid.");
    }
  }
  await preflightActionProposal(id, ownerId, toActionDependencies(dependencies));
  return mapProposal(requireActionProposal(id, ownerId));
}

export async function executeArchiveOperation(
  id: number,
  ownerId: string,
  confirmed: boolean,
  dependencies?: OperationDependencies,
): Promise<ArchiveOperation> {
  if (!confirmed) throw new Error("Explicit operation confirmation is required.");
  ensureLegacy(id, ownerId);
  await executeActionProposal(id, ownerId, true, toActionDependencies(dependencies), {
    postflight: true,
  });
  const executed = requireActionProposal(id, ownerId);
  await linkAcquisitionPostflight(executed, ownerId);
  return mapProposal(requireActionProposal(id, ownerId));
}

/** Preserve the acquisition-job import breadcrumb the original service wrote. */
async function linkAcquisitionPostflight(proposal: ActionProposal, ownerId: string) {
  if (!proposal.acquisitionJobId) return;
  if (!Object.keys(proposal.postflight).length) return;
  const row = archiveDb.prepare(
    "SELECT metadata_json FROM acquisition_job WHERE id = ? AND owner_id = ?",
  ).get(proposal.acquisitionJobId, ownerId) as { metadata_json: string } | undefined;
  if (!row) return;
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metadata_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = {};
  }
  archiveDb.prepare(`
    UPDATE acquisition_job
    SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_id = ?
  `).run(JSON.stringify({
    ...metadata,
    importOperationId: proposal.id,
    postImport: proposal.postflight,
  }), proposal.acquisitionJobId, ownerId);
}

export function cancelArchiveOperation(id: number, ownerId: string): ArchiveOperation {
  const existing = ensureLegacy(id, ownerId);
  const status = toOperationStatus(existing);
  if (status === "cancelled") return mapProposal(existing);
  if (["executing", "completed", "rolled_back"].includes(status)) {
    throw new Error(`Cannot cancel an operation in ${status} state.`);
  }
  cancelActionProposal(id, ownerId);
  return mapProposal(requireActionProposal(id, ownerId));
}

export async function retryArchiveOperation(
  id: number,
  ownerId: string,
  dependencies?: OperationDependencies,
): Promise<ArchiveOperation> {
  const existing = ensureLegacy(id, ownerId);
  const status = toOperationStatus(existing);
  if (!["failed", "cancelled"].includes(status)) {
    throw new Error("Only failed or cancelled archive operations can be retried.");
  }
  if (existing.retryCount >= existing.maxRetries) {
    throw new Error("Archive operation retry limit has been reached.");
  }
  await retryActionProposal(id, ownerId, toActionDependencies(dependencies));
  return mapProposal(requireActionProposal(id, ownerId));
}

export async function rollbackArchiveOperation(
  id: number,
  ownerId: string,
  confirmed: boolean,
  dependencies?: OperationDependencies,
): Promise<ArchiveOperation> {
  if (!confirmed) throw new Error("Explicit rollback confirmation is required.");
  const existing = ensureLegacy(id, ownerId);
  const status = toOperationStatus(existing);
  if (status === "rolled_back") return mapProposal(existing);
  if (status !== "completed") throw new Error("Only completed operations can be rolled back.");
  await revertActionProposal(id, ownerId, true, toActionDependencies(dependencies));
  return mapProposal(requireActionProposal(id, ownerId));
}

export type { ActionProposalStatus };
