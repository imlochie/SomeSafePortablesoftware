import { createHash } from "node:crypto";
import { archiveDb } from "../../lib/archive-db";
import { getActionHandler } from "./registry";
import {
  asPhase,
  asProposalStatus,
  asRisk,
  asStepStatus,
  isActionSource,
  isActionType,
  type ActionEvent,
  type ActionPhase,
  type ActionProposal,
  type ActionProposalCounts,
  type ActionProposalStatus,
  type ActionSource,
  type ActionStep,
  type ActionStepStatus,
  type ActionTarget,
  type ActionType,
  type ProposalReversibility,
  type CreateActionProposalInput,
  type CreateActionStepInput,
} from "./types";

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

function target(value: unknown): ActionTarget {
  const data = json(value);
  return {
    kind: typeof data.kind === "string" ? data.kind : "unknown",
    id: data.id == null ? null : String(data.id),
    path: data.path == null ? null : String(data.path),
    label: data.label == null ? null : String(data.label),
  };
}

function normalizeTarget(value: Partial<ActionTarget> | undefined, fallbackKind: string): ActionTarget {
  return {
    kind: value?.kind?.trim() || fallbackKind,
    id: value?.id ?? null,
    path: value?.path ?? null,
    label: value?.label ?? null,
  };
}

function requireType(value: unknown): ActionType {
  if (!isActionType(value)) throw new Error(`Action type "${String(value)}" is not supported.`);
  return value;
}

function requireSource(value: unknown): ActionSource {
  if (!isActionSource(value)) throw new Error(`Action source "${String(value)}" is not supported.`);
  return value;
}

function mapStep(row: Record<string, unknown>): ActionStep {
  return {
    id: Number(row.id),
    proposalId: Number(row.proposal_id),
    stepIndex: Number(row.step_index),
    type: requireType(row.type),
    status: asStepStatus(row.status),
    selected: Number(row.selected) === 1,
    summary: String(row.summary ?? ""),
    target: target(row.target_json),
    before: json(row.before_json),
    after: json(row.after_json),
    preflight: json(row.preflight_json),
    execution: json(row.execution_json),
    verification: json(row.verification_json),
    revert: json(row.revert_json),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEvent(row: Record<string, unknown>): ActionEvent {
  return {
    id: Number(row.id),
    stepId: row.step_id == null ? null : Number(row.step_id),
    phase: asPhase(row.phase),
    fromStatus: row.from_status == null ? null : String(row.from_status),
    toStatus: String(row.to_status),
    detail: String(row.detail),
    metadata: json(row.metadata_json),
    createdAt: String(row.created_at),
  };
}

function countSteps(steps: ActionStep[]): ActionProposalCounts {
  return {
    total: steps.length,
    selected: steps.filter((step) => step.selected).length,
    pending: steps.filter((step) => step.status === "pending" || step.status === "ready").length,
    completed: steps.filter((step) => step.status === "completed").length,
    failed: steps.filter((step) => step.status === "failed").length,
    skipped: steps.filter((step) => step.status === "skipped").length,
    reverted: steps.filter((step) => step.status === "reverted").length,
  };
}

export function readActionSteps(proposalId: number, ownerId: string): ActionStep[] {
  return (archiveDb.prepare(`
    SELECT * FROM action_step
    WHERE proposal_id = ? AND owner_id = ?
    ORDER BY step_index ASC, id ASC
  `).all(proposalId, ownerId) as Array<Record<string, unknown>>).map(mapStep);
}

export function readActionEvents(proposalId: number, ownerId: string): ActionEvent[] {
  return (archiveDb.prepare(`
    SELECT * FROM action_event
    WHERE proposal_id = ? AND owner_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(proposalId, ownerId) as Array<Record<string, unknown>>).map(mapEvent);
}


/**
 * Whether a revert can be offered for this proposal *right now*.
 *
 * Two separate truths, deliberately not collapsed: what the action family can
 * do in principle (the handler's declaration), and whether this particular
 * proposal is in a state where a revert would actually be accepted. The review
 * surface previously derived the second from `status`, which meant it offered
 * undo for irreversible families and stayed silent about the conditions a
 * conditional revert depends on.
 */
function resolveReversibility(
  type: ActionType,
  status: ActionProposalStatus,
  counts: ActionProposalCounts,
): ProposalReversibility {
  const declared = getActionHandler(type).reversibility;
  const revertableSteps = counts.completed;
  let blockedReason: string | null = null;

  if (declared.kind === "irreversible") {
    blockedReason = "This action cannot be undone by Archive Assistant.";
  } else if (revertableSteps < 1) {
    // "Never applied" and "applied, then undone" are different facts, and a
    // trust surface must not blur them: saying "nothing has been applied" after
    // a successful revert would deny that anything ever happened.
    blockedReason = counts.reverted > 0
      ? "No applied changes remain to undo."
      : "Nothing has been applied yet, so there is nothing to undo.";
  } else if (status !== "completed" && status !== "partially_completed") {
    blockedReason = "Nothing has been applied yet, so there is nothing to undo.";
  }

  return {
    ...declared,
    available: blockedReason === null,
    revertableSteps,
    blockedReason,
  };
}

function mapProposal(row: Record<string, unknown>, ownerId: string): ActionProposal {
  const id = Number(row.id);
  const steps = readActionSteps(id, ownerId);
  const type = requireType(row.type);
  const status = asProposalStatus(row.status);
  const counts = countSteps(steps);
  return {
    id,
    proposalKey: String(row.proposal_key),
    type,
    reversibility: resolveReversibility(type, status, counts),
    source: requireSource(row.source),
    reason: String(row.reason),
    status,
    risk: asRisk(row.risk),
    requiresApproval: Number(row.requires_approval) === 1,
    dryRun: Number(row.dry_run) === 1,
    allowCreateDirectories: Number(row.allow_create_directories) === 1,
    reviewItemId: row.review_item_id == null ? null : Number(row.review_item_id),
    acquisitionJobId: row.acquisition_job_id == null ? null : Number(row.acquisition_job_id),
    downloadJobId: row.download_job_id == null ? null : Number(row.download_job_id),
    planHash: String(row.plan_hash ?? ""),
    target: target(row.target_json),
    evidence: json(row.evidence_json),
    approval: json(row.approval_json),
    preflight: json(row.preflight_json),
    execution: json(row.execution_json),
    verification: json(row.verification_json),
    revert: json(row.revert_json),
    postflight: json(row.postflight_json),
    retryCount: Number(row.retry_count),
    maxRetries: Number(row.max_retries),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    counts,
    steps,
    events: readActionEvents(id, ownerId),
    createdAt: String(row.created_at),
    approvedAt: row.approved_at == null ? null : String(row.approved_at),
    executedAt: row.executed_at == null ? null : String(row.executed_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
    updatedAt: String(row.updated_at),
  };
}

export function readActionProposal(id: number, ownerId: string): ActionProposal | null {
  const row = archiveDb.prepare(
    "SELECT * FROM action_proposal WHERE id = ? AND owner_id = ?",
  ).get(id, ownerId) as Record<string, unknown> | undefined;
  return row ? mapProposal(row, ownerId) : null;
}

export function requireActionProposal(id: number, ownerId: string): ActionProposal {
  const proposal = readActionProposal(id, ownerId);
  if (!proposal) throw new Error("Action proposal not found.");
  return proposal;
}

export function readActionProposalByKey(key: string, ownerId: string): ActionProposal | null {
  const row = archiveDb.prepare(
    "SELECT * FROM action_proposal WHERE owner_id = ? AND proposal_key = ?",
  ).get(ownerId, key) as Record<string, unknown> | undefined;
  return row ? mapProposal(row, ownerId) : null;
}

export interface ListActionProposalFilters {
  status?: ActionProposalStatus;
  type?: ActionType;
  source?: ActionSource;
}

export function listActionProposals(
  ownerId: string,
  filters: ListActionProposalFilters = {},
): ActionProposal[] {
  const conditions = ["owner_id = ?"];
  const values: string[] = [ownerId];
  if (filters.status) {
    conditions.push("status = ?");
    values.push(filters.status);
  }
  if (filters.type) {
    conditions.push("type = ?");
    values.push(filters.type);
  }
  if (filters.source) {
    conditions.push("source = ?");
    values.push(filters.source);
  }
  return (archiveDb.prepare(`
    SELECT * FROM action_proposal
    WHERE ${conditions.join(" AND ")}
    ORDER BY updated_at DESC, id DESC
  `).all(...values) as Array<Record<string, unknown>>).map((row) => mapProposal(row, ownerId));
}

/**
 * Hash of the reviewable substance of a plan. Preflight re-derives this so a
 * proposal that changed after approval cannot be executed.
 */
export function planHash(steps: Array<Pick<ActionStep, "type" | "selected" | "before" | "after" | "target">>) {
  return createHash("sha256").update(JSON.stringify(steps.map((step) => ({
    type: step.type,
    selected: step.selected,
    target: step.target,
    before: step.before,
    after: step.after,
  })))).digest("hex");
}

export function proposalKeyFor(ownerId: string, input: CreateActionProposalInput) {
  if (input.idempotencyKey?.trim()) return input.idempotencyKey.trim();
  return createHash("sha256").update(JSON.stringify({
    ownerId,
    type: input.type,
    source: input.source,
    steps: input.steps.map((step) => ({
      type: step.type,
      target: step.target ?? null,
      before: step.before ?? {},
      after: step.after ?? {},
    })),
  })).digest("hex");
}

export function appendActionEvent(
  proposalId: number,
  ownerId: string,
  entry: {
    phase: ActionPhase;
    fromStatus?: string | null;
    toStatus: string;
    detail: string;
    metadata?: Record<string, unknown>;
    stepId?: number | null;
  },
) {
  archiveDb.prepare(`
    INSERT INTO action_event
      (proposal_id, step_id, owner_id, phase, from_status, to_status, detail, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proposalId,
    entry.stepId ?? null,
    ownerId,
    entry.phase,
    entry.fromStatus ?? null,
    entry.toStatus,
    entry.detail,
    JSON.stringify(entry.metadata ?? {}),
  );
}

export function updateProposalRow(
  id: number,
  ownerId: string,
  updates: Record<string, string | number | null>,
) {
  const entries = Object.entries(updates);
  if (!entries.length) return;
  archiveDb.prepare(`
    UPDATE action_proposal
    SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_id = ?
  `).run(...entries.map(([, value]) => value), id, ownerId);
}

export function updateStepRow(
  id: number,
  ownerId: string,
  updates: Record<string, string | number | null>,
) {
  const entries = Object.entries(updates);
  if (!entries.length) return;
  archiveDb.prepare(`
    UPDATE action_step
    SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_id = ?
  `).run(...entries.map(([, value]) => value), id, ownerId);
}

export function setProposalStatus(
  proposal: ActionProposal,
  ownerId: string,
  nextStatus: ActionProposalStatus,
  phase: ActionPhase,
  detail: string,
  metadata: Record<string, unknown> = {},
  extraUpdates: Record<string, string | number | null> = {},
) {
  updateProposalRow(proposal.id, ownerId, { status: nextStatus, ...extraUpdates });
  appendActionEvent(proposal.id, ownerId, {
    phase,
    fromStatus: proposal.status,
    toStatus: nextStatus,
    detail,
    metadata,
  });
}

export function insertActionProposal(
  ownerId: string,
  input: CreateActionProposalInput,
  resolved: {
    key: string;
    requiresApproval: boolean;
    status: ActionProposalStatus;
    risk: string;
    reviewItemId: number | null;
    steps: Array<CreateActionStepInput & { summary: string; target: ActionTarget }>;
    hash: string;
  },
): ActionProposal {
  archiveDb.exec("BEGIN IMMEDIATE");
  try {
    const result = archiveDb.prepare(`
      INSERT INTO action_proposal
        (owner_id, proposal_key, type, source, reason, status, risk, requires_approval,
         dry_run, allow_create_directories, review_item_id, acquisition_job_id, download_job_id,
         plan_hash, target_json, evidence_json, max_retries, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ownerId,
      resolved.key,
      input.type,
      input.source,
      input.reason,
      resolved.status,
      resolved.risk,
      resolved.requiresApproval ? 1 : 0,
      input.dryRun ? 1 : 0,
      input.allowCreateDirectories ? 1 : 0,
      resolved.reviewItemId,
      input.acquisitionJobId ?? null,
      input.downloadJobId ?? null,
      resolved.hash,
      JSON.stringify(normalizeTarget(input.target, "archive")),
      JSON.stringify(input.evidence ?? {}),
      input.maxRetries ?? 3,
      resolved.status === "approved" ? new Date().toISOString() : null,
    );
    const proposalId = Number(result.lastInsertRowid);
    const insertStep = archiveDb.prepare(`
      INSERT INTO action_step
        (proposal_id, owner_id, step_index, type, status, selected, summary,
         target_json, before_json, after_json)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `);
    resolved.steps.forEach((step, index) => {
      insertStep.run(
        proposalId,
        ownerId,
        index,
        step.type,
        step.selected === false ? 0 : 1,
        step.summary,
        JSON.stringify(step.target),
        JSON.stringify(step.before ?? {}),
        JSON.stringify(step.after ?? {}),
      );
    });
    archiveDb.exec("COMMIT");
    return requireActionProposal(proposalId, ownerId);
  } catch (error) {
    archiveDb.exec("ROLLBACK");
    throw error;
  }
}

export { normalizeTarget, json, record, countSteps };
export type { ActionStepStatus };
