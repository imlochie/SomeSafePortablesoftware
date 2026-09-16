import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { addEvent, readSettings } from "../../lib/archive-db";
import { inspectLocalMedia } from "../media";
import { readReviewItem, ensureReviewItem, approveReviewItem } from "../review-queue";
import { runArchivePostflight } from "./postflight";
import { getActionHandler, requireSupportedHandler } from "./registry";
import {
  appendActionEvent,
  insertActionProposal,
  listActionProposals,
  normalizeTarget,
  planHash,
  proposalKeyFor,
  readActionProposal,
  readActionProposalByKey,
  requireActionProposal,
  setProposalStatus,
  updateProposalRow,
  updateStepRow,
  type ListActionProposalFilters,
} from "./store";
import {
  type ActionDependencies,
  type ActionProposal,
  type ActionProposalStatus,
  type ActionStep,
  type CreateActionProposalInput,
} from "./types";

export function defaultActionDependencies(): ActionDependencies {
  const settings = readSettings();
  return {
    stat: (path) => fs.stat(path),
    access: (path, mode) => fs.access(path, mode),
    copyFile: (source, destination, mode) => fs.copyFile(source, destination, mode),
    rename: (source, destination) => fs.rename(source, destination),
    unlink: (path) => fs.unlink(path),
    mkdir: async (path) => {
      await fs.mkdir(path, { recursive: true });
    },
    rmdir: (path) => fs.rmdir(path),
    inspect: (path) => inspectLocalMedia(path, settings),
  };
}

function selectedSteps(proposal: ActionProposal) {
  return proposal.steps.filter((step) => step.selected && step.status !== "skipped");
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function failStep(step: ActionStep, ownerId: string, code: string, detail: string, phase: "preflight" | "execute" | "verify" | "revert") {
  updateStepRow(step.id, ownerId, {
    status: "failed",
    error_code: code,
    error_message: detail,
  });
  appendActionEvent(step.proposalId, ownerId, {
    phase,
    stepId: step.id,
    fromStatus: step.status,
    toStatus: "failed",
    detail,
    metadata: { stepIndex: step.stepIndex },
  });
}

/**
 * Create a reviewable proposal. This never mutates the archive — it only
 * records what *could* change, with the evidence that produced it.
 */
export function createActionProposal(
  ownerId: string,
  input: CreateActionProposalInput,
): ActionProposal {
  if (!ownerId.trim()) throw new Error("An action owner is required.");
  if (!input.reason.trim()) throw new Error("An action proposal reason is required.");
  if (!input.steps.length) throw new Error("An action proposal requires at least one step.");

  const handler = requireSupportedHandler(input.type);
  for (const step of input.steps) {
    // Mixed-type plans are allowed, but every step must be a real family.
    requireSupportedHandler(step.type);
  }

  const key = proposalKeyFor(ownerId, input);
  const existing = readActionProposalByKey(key, ownerId);
  if (existing) return existing;

  let reviewItemId = input.reviewItemId ?? null;
  if (reviewItemId !== null) {
    const review = readReviewItem(reviewItemId, ownerId);
    if (!review) throw new Error("Linked review item not found for this owner.");
    if (input.preApproved && review.state !== "approved") {
      throw new Error("A pre-approved action proposal requires an approved review item.");
    }
  }

  const steps = input.steps.map((step, index) => {
    const target = normalizeTarget(
      step.target ?? {
        kind: "file",
        path: typeof step.before?.path === "string" ? step.before.path : null,
      },
      "file",
    );
    const resolvedStep = {
      ...step,
      target,
      before: step.before ?? {},
      after: step.after ?? {},
      summary: step.summary?.trim() || getActionHandler(step.type).summarize({
        id: 0,
        proposalId: 0,
        stepIndex: index,
        type: step.type,
        status: "pending",
        selected: step.selected !== false,
        summary: "",
        target,
        before: step.before ?? {},
        after: step.after ?? {},
        preflight: {},
        execution: {},
        verification: {},
        revert: {},
        errorCode: null,
        errorMessage: null,
        createdAt: "",
        updatedAt: "",
      }),
    };
    return resolvedStep;
  });

  const proposal = insertActionProposal(ownerId, input, {
    key,
    requiresApproval: !input.preApproved,
    status: input.preApproved ? "approved" : "proposed",
    risk: input.risk ?? handler.risk,
    reviewItemId,
    steps,
    hash: planHash(steps.map((step) => ({
      type: step.type,
      selected: step.selected !== false,
      before: step.before,
      after: step.after,
      target: step.target,
    }))),
  });

  appendActionEvent(proposal.id, ownerId, {
    phase: "propose",
    toStatus: proposal.status,
    detail: `Proposed ${proposal.steps.length} ${proposal.type} change(s) from ${proposal.source}.`,
    metadata: { steps: proposal.steps.length, risk: proposal.risk },
  });
  addEvent("info", `Action proposal ${proposal.id} (${proposal.type}) created.`, "action-engine", ownerId);
  return requireActionProposal(proposal.id, ownerId);
}

/** Deselect or reselect individual steps before approval. */
export function setActionStepSelection(
  proposalId: number,
  ownerId: string,
  selections: Array<{ stepId: number; selected: boolean }>,
): ActionProposal {
  const proposal = requireActionProposal(proposalId, ownerId);
  if (!["draft", "proposed"].includes(proposal.status)) {
    throw new Error(`Cannot change step selection while the proposal is ${proposal.status}.`);
  }
  const byId = new Map(proposal.steps.map((step) => [step.id, step]));
  for (const selection of selections) {
    const step = byId.get(selection.stepId);
    if (!step) throw new Error(`Step ${selection.stepId} does not belong to this proposal.`);
    updateStepRow(step.id, ownerId, {
      selected: selection.selected ? 1 : 0,
      status: selection.selected ? "pending" : "skipped",
    });
  }
  const updated = requireActionProposal(proposalId, ownerId);
  updateProposalRow(proposalId, ownerId, {
    plan_hash: planHash(updated.steps.map((step) => ({
      type: step.type,
      selected: step.selected,
      before: step.before,
      after: step.after,
      target: step.target,
    }))),
  });
  appendActionEvent(proposalId, ownerId, {
    phase: "select",
    fromStatus: proposal.status,
    toStatus: proposal.status,
    detail: `Step selection updated; ${updated.counts.selected} of ${updated.counts.total} steps selected.`,
    metadata: { selected: updated.counts.selected, total: updated.counts.total },
  });
  return requireActionProposal(proposalId, ownerId);
}

/**
 * Explicit, durable approval. Approval alone changes nothing — it only unlocks
 * preflight. A review-queue item is created so approvals stay auditable
 * alongside every other operator decision.
 */
export function approveActionProposal(
  proposalId: number,
  ownerId: string,
  note?: string | null,
): ActionProposal {
  const proposal = requireActionProposal(proposalId, ownerId);
  if (proposal.status === "approved") return proposal;
  if (!["draft", "proposed"].includes(proposal.status)) {
    throw new Error(`Cannot approve a proposal in ${proposal.status} state.`);
  }
  if (!proposal.counts.selected) {
    throw new Error("At least one step must be selected before approval.");
  }

  const review = ensureReviewItem(ownerId, {
    kind: "operation_approval",
    subjectKey: `action-proposal:${proposal.id}`,
    title: `${proposal.type}: ${proposal.reason}`,
    payload: {
      actionProposalId: proposal.id,
      type: proposal.type,
      source: proposal.source,
      steps: proposal.counts.selected,
      risk: proposal.risk,
    },
  });
  if (review.state !== "approved") approveReviewItem(review.id, ownerId, note ?? null);

  const approvedAt = new Date().toISOString();
  setProposalStatus(proposal, ownerId, "approved", "approve", "Operator approved the action proposal.", {
    selectedSteps: proposal.counts.selected,
    reviewItemId: review.id,
  }, {
    approved_at: approvedAt,
    review_item_id: review.id,
    approval_json: JSON.stringify({
      approvedBy: ownerId,
      approvedAt,
      note: note?.trim() || null,
      reviewItemId: review.id,
      selectedSteps: proposal.counts.selected,
      planHash: proposal.planHash,
    }),
  });
  addEvent("success", `Action proposal ${proposal.id} approved.`, "action-engine", ownerId);
  return requireActionProposal(proposalId, ownerId);
}

/**
 * Re-check every safety condition immediately before execution, and confirm the
 * plan has not changed since approval. Never mutates the archive.
 */
export async function preflightActionProposal(
  proposalId: number,
  ownerId: string,
  dependencies: ActionDependencies = defaultActionDependencies(),
): Promise<ActionProposal> {
  let proposal = requireActionProposal(proposalId, ownerId);
  if (!["approved", "ready", "failed"].includes(proposal.status)) {
    throw new Error(`Cannot preflight a proposal in ${proposal.status} state.`);
  }
  if (proposal.requiresApproval && !proposal.approvedAt) {
    throw new Error("The action proposal requires approval before preflight.");
  }
  if (proposal.reviewItemId !== null) {
    const review = readReviewItem(proposal.reviewItemId, ownerId);
    if (!review || review.state !== "approved") {
      throw new Error("The action approval is no longer valid.");
    }
  }

  const currentHash = planHash(proposal.steps.map((step) => ({
    type: step.type,
    selected: step.selected,
    before: step.before,
    after: step.after,
    target: step.target,
  })));
  if (currentHash !== proposal.planHash) {
    const detail = "The proposal changed after approval; re-approval is required.";
    setProposalStatus(proposal, ownerId, "failed", "preflight", detail, { expected: proposal.planHash, actual: currentHash }, {
      error_code: "PLAN_CHANGED",
      error_message: detail,
    });
    return requireActionProposal(proposalId, ownerId);
  }

  setProposalStatus(proposal, ownerId, "preflight", "preflight", "Preflight started; no files are modified.", {}, {
    error_code: null,
    error_message: null,
  });
  proposal = requireActionProposal(proposalId, ownerId);

  const context = { ownerId, proposal, dependencies };
  const results: Array<Record<string, unknown>> = [];
  let failures = 0;
  const seenDestinations = new Set<string>();

  for (const step of selectedSteps(proposal)) {
    try {
      // Intra-plan collision detection: two steps must not target one path.
      const destination = typeof step.after.path === "string" ? step.after.path.toLowerCase() : null;
      if (destination) {
        if (seenDestinations.has(destination)) {
          throw new Error("Another step in this proposal already targets the same destination path.");
        }
        seenDestinations.add(destination);
      }
      const handler = requireSupportedHandler(step.type);
      const outcome = await handler.preflight(step, context);
      updateStepRow(step.id, ownerId, {
        status: "ready",
        preflight_json: JSON.stringify(outcome),
        error_code: null,
        error_message: null,
      });
      appendActionEvent(proposalId, ownerId, {
        phase: "preflight",
        stepId: step.id,
        fromStatus: step.status,
        toStatus: "ready",
        detail: `Step ${step.stepIndex + 1} passed preflight.`,
        metadata: { stepIndex: step.stepIndex },
      });
      results.push({ stepId: step.id, ok: true, ...outcome });
    } catch (error) {
      failures += 1;
      const detail = message(error, "Step preflight failed.");
      failStep(step, ownerId, "PREFLIGHT_FAILED", detail, "preflight");
      results.push({ stepId: step.id, ok: false, error: detail });
    }
  }

  const checked = results.length;
  const summary = {
    checkedAt: new Date().toISOString(),
    steps: checked,
    passed: checked - failures,
    failed: failures,
    results,
  };
  const allFailed = checked > 0 && failures === checked;
  const nextStatus: ActionProposalStatus = checked === 0 || allFailed ? "failed" : "ready";
  const detail = checked === 0
    ? "No selected steps were available to preflight."
    : allFailed
      ? "Every selected step failed preflight."
      : `Preflight passed for ${checked - failures} of ${checked} step(s).`;

  setProposalStatus(requireActionProposal(proposalId, ownerId), ownerId, nextStatus, "preflight", detail, summary, {
    preflight_json: JSON.stringify(summary),
    ...(nextStatus === "failed"
      ? { error_code: "PREFLIGHT_FAILED", error_message: detail }
      : { error_code: null, error_message: null }),
  });
  if (nextStatus === "failed") {
    addEvent("error", `Action proposal ${proposalId} failed preflight.`, "action-engine", ownerId);
  }
  return requireActionProposal(proposalId, ownerId);
}

/**
 * Execute the approved plan. Requires explicit confirmation, a current
 * successful preflight, and a still-valid approval. Each step is verified
 * immediately after it runs.
 */
export interface ExecuteActionOptions {
  /** Re-scan, refresh Plex, and reconcile after a successful mutation. */
  postflight?: boolean;
}

export async function executeActionProposal(
  proposalId: number,
  ownerId: string,
  confirmed: boolean,
  dependencies: ActionDependencies = defaultActionDependencies(),
  options: ExecuteActionOptions = {},
): Promise<ActionProposal> {
  if (!confirmed) throw new Error("Explicit execution confirmation is required.");
  let proposal = requireActionProposal(proposalId, ownerId);
  if (["completed", "reverted"].includes(proposal.status)) return proposal;
  if (proposal.status !== "ready") {
    proposal = await preflightActionProposal(proposalId, ownerId, dependencies);
  }
  if (proposal.status !== "ready") return proposal;
  if (proposal.reviewItemId !== null) {
    const review = readReviewItem(proposal.reviewItemId, ownerId);
    if (!review || review.state !== "approved") {
      throw new Error("The approved review item is required at execution time.");
    }
  }

  if (proposal.dryRun) {
    setProposalStatus(proposal, ownerId, "ready", "execute", "Dry run completed; no filesystem mutation was performed.", {
      steps: proposal.counts.selected,
    });
    return requireActionProposal(proposalId, ownerId);
  }

  const executedAt = new Date().toISOString();
  setProposalStatus(proposal, ownerId, "executing", "execute", "Execution started after explicit confirmation.", {}, {
    executed_at: executedAt,
    error_code: null,
    error_message: null,
  });
  proposal = requireActionProposal(proposalId, ownerId);
  const context = { ownerId, proposal, dependencies };

  let completed = 0;
  let failed = 0;
  for (const step of proposal.steps) {
    if (!step.selected || step.status !== "ready") continue;
    const handler = getActionHandler(step.type);
    updateStepRow(step.id, ownerId, { status: "executing" });
    try {
      const execution = await handler.execute(step, context);
      updateStepRow(step.id, ownerId, { execution_json: JSON.stringify(execution) });
      const current = requireActionProposal(proposalId, ownerId).steps.find((entry) => entry.id === step.id)!;
      const verification = await handler.verify(current, context);
      updateStepRow(step.id, ownerId, {
        status: "completed",
        verification_json: JSON.stringify(verification),
        revert_json: JSON.stringify({
          supported: handler.reversibility.kind !== "irreversible",
          kind: handler.reversibility.kind,
          strategy: handler.type,
          sourcePath: step.before.path ?? null,
          destinationPath: step.after.path ?? null,
        }),
      });
      appendActionEvent(proposalId, ownerId, {
        phase: "verify",
        stepId: step.id,
        fromStatus: "executing",
        toStatus: "completed",
        detail: `Step ${step.stepIndex + 1} executed and verified.`,
        metadata: { stepIndex: step.stepIndex, verification },
      });
      completed += 1;
    } catch (error) {
      failed += 1;
      const detail = message(error, "Step execution failed.");
      failStep(step, ownerId, "EXECUTION_FAILED", detail, "execute");
    }
  }

  const attempted = completed + failed;
  const status: ActionProposalStatus = failed === 0 && completed > 0
    ? "completed"
    : completed === 0
      ? "failed"
      : "partially_completed";
  const summary = {
    attempted,
    completed,
    failed,
    finishedAt: new Date().toISOString(),
  };
  const detail = `Executed ${completed} of ${attempted} step(s)${failed ? `; ${failed} failed.` : "."}`;
  setProposalStatus(requireActionProposal(proposalId, ownerId), ownerId, status, "execute", detail, summary, {
    execution_json: JSON.stringify(summary),
    completed_at: status === "completed" ? new Date().toISOString() : null,
    ...(failed
      ? { error_code: "EXECUTION_FAILED", error_message: detail }
      : { error_code: null, error_message: null }),
  });
  addEvent(
    failed ? "error" : "success",
    `Action proposal ${proposalId} ${status.replace("_", " ")}: ${detail}`,
    "action-engine",
    ownerId,
  );

  const verification = {
    total: attempted,
    verified: completed,
    failed,
    verifiedAt: new Date().toISOString(),
  };
  updateProposalRow(proposalId, ownerId, { verification_json: JSON.stringify(verification) });
  appendActionEvent(proposalId, ownerId, {
    phase: "record",
    toStatus: status,
    detail: `Recorded ${completed}/${attempted} verified change(s) in history.`,
    metadata: verification,
  });

  // RESULT → ARCHIVE CHANGES → OBSERVE: re-observe only if files actually moved.
  if (options.postflight && completed > 0) {
    const outcome = await runArchivePostflight(ownerId);
    updateProposalRow(proposalId, ownerId, { postflight_json: JSON.stringify(outcome) });
    appendActionEvent(proposalId, ownerId, {
      phase: "record",
      toStatus: status,
      detail: outcome.errors.length
        ? "Post-action refresh completed with recorded errors."
        : "Post-action archive scan, Plex refresh, and reconciliation completed.",
      metadata: outcome,
    });
  }
  return requireActionProposal(proposalId, ownerId);
}

/** Put the archive back the way it was, step by step, newest first. */
export async function revertActionProposal(
  proposalId: number,
  ownerId: string,
  confirmed: boolean,
  dependencies: ActionDependencies = defaultActionDependencies(),
): Promise<ActionProposal> {
  if (!confirmed) throw new Error("Explicit revert confirmation is required.");
  const proposal = requireActionProposal(proposalId, ownerId);
  if (proposal.status === "reverted") return proposal;
  if (!["completed", "partially_completed"].includes(proposal.status)) {
    throw new Error("Only completed or partially completed proposals can be reverted.");
  }

  const context = { ownerId, proposal, dependencies };
  const completedSteps = proposal.steps
    .filter((step) => step.status === "completed")
    .sort((left, right) => right.stepIndex - left.stepIndex);
  if (!completedSteps.length) throw new Error("No completed steps are available to revert.");

  let reverted = 0;
  let failed = 0;
  for (const step of completedSteps) {
    const handler = getActionHandler(step.type);
    if (handler.reversibility.kind === "irreversible") {
      failed += 1;
      failStep(step, ownerId, "REVERT_UNSUPPORTED", `The "${step.type}" action cannot be reverted.`, "revert");
      continue;
    }
    try {
      const outcome = await handler.revert(step, context);
      updateStepRow(step.id, ownerId, {
        status: "reverted",
        revert_json: JSON.stringify({ ...step.revert, ...outcome, reverted: true }),
      });
      appendActionEvent(proposalId, ownerId, {
        phase: "revert",
        stepId: step.id,
        fromStatus: "completed",
        toStatus: "reverted",
        detail: `Step ${step.stepIndex + 1} reverted.`,
        metadata: { stepIndex: step.stepIndex, outcome },
      });
      reverted += 1;
    } catch (error) {
      failed += 1;
      const detail = message(error, "Step revert failed.");
      updateStepRow(step.id, ownerId, { error_code: "REVERT_FAILED", error_message: detail });
      appendActionEvent(proposalId, ownerId, {
        phase: "revert",
        stepId: step.id,
        fromStatus: "completed",
        toStatus: "completed",
        detail,
        metadata: { stepIndex: step.stepIndex, recoveryRequired: true },
      });
    }
  }

  const summary = { reverted, failed, revertedAt: new Date().toISOString() };
  const status: ActionProposalStatus = failed === 0 ? "reverted" : "partially_completed";
  const detail = failed === 0
    ? `Reverted ${reverted} change(s).`
    : `Reverted ${reverted} change(s); ${failed} could not be reverted.`;
  setProposalStatus(requireActionProposal(proposalId, ownerId), ownerId, status, "revert", detail, summary, {
    revert_json: JSON.stringify(summary),
    ...(failed ? { error_code: "REVERT_FAILED", error_message: detail } : {}),
  });
  addEvent(failed ? "warning" : "info", `Action proposal ${proposalId}: ${detail}`, "action-engine", ownerId);
  return requireActionProposal(proposalId, ownerId);
}

export function cancelActionProposal(proposalId: number, ownerId: string): ActionProposal {
  const proposal = requireActionProposal(proposalId, ownerId);
  if (proposal.status === "cancelled") return proposal;
  if (["executing", "completed", "partially_completed", "reverted"].includes(proposal.status)) {
    throw new Error(`Cannot cancel a proposal in ${proposal.status} state.`);
  }
  setProposalStatus(proposal, ownerId, "cancelled", "cancel", "Action proposal cancelled before execution.", {}, {
    cancelled_at: new Date().toISOString(),
  });
  addEvent("info", `Action proposal ${proposalId} cancelled.`, "action-engine", ownerId);
  return requireActionProposal(proposalId, ownerId);
}

export async function retryActionProposal(
  proposalId: number,
  ownerId: string,
  dependencies: ActionDependencies = defaultActionDependencies(),
): Promise<ActionProposal> {
  const proposal = requireActionProposal(proposalId, ownerId);
  if (!["failed", "partially_completed", "cancelled"].includes(proposal.status)) {
    throw new Error("Only failed, partially completed, or cancelled proposals can be retried.");
  }
  if (proposal.retryCount >= proposal.maxRetries) {
    throw new Error("Action proposal retry limit has been reached.");
  }
  // Completed steps stay completed; only the failed ones are retried.
  for (const step of proposal.steps) {
    if (step.status === "failed") {
      updateStepRow(step.id, ownerId, { status: "pending", error_code: null, error_message: null });
    }
  }
  setProposalStatus(proposal, ownerId, "approved", "approve", "Action proposal retry planned.", {
    retryCount: proposal.retryCount + 1,
  }, {
    retry_count: proposal.retryCount + 1,
    error_code: null,
    error_message: null,
    cancelled_at: null,
  });
  return preflightActionProposal(proposalId, ownerId, dependencies);
}

export {
  listActionProposals,
  readActionProposal,
  requireActionProposal,
  readActionProposalByKey,
  type ListActionProposalFilters,
};
