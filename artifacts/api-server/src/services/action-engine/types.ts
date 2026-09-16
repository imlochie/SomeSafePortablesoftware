/**
 * Universal Archive Action Engine — core vocabulary.
 *
 * Every archive-mutating capability in Archive Assistant is expressed as an
 * ActionProposal made of ActionSteps. Intelligence features answer only one
 * question — "what action can resolve this finding?" — and the engine owns the
 * approve → preflight → execute → verify → record → revert lifecycle.
 */

export const actionTypes = [
  "rename",
  "move",
  "delete",
  "restore",
  "reconcile",
  "acquire",
  "import",
  "link",
  "unlink",
  "metadata_update",
  "plex_sync",
] as const;
export type ActionType = (typeof actionTypes)[number];

/** Where a proposal came from. Sources derive steps from server-side evidence. */
export const actionSources = [
  "naming_intelligence",
  "acquisition_intelligence",
  "reconciliation",
  "identity_audit",
  "archive_review",
  "assistant",
  "operator",
] as const;
export type ActionSource = (typeof actionSources)[number];

export const actionProposalStatuses = [
  "draft",
  "proposed",
  "approved",
  "preflight",
  "ready",
  "executing",
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
  "reverted",
] as const;
export type ActionProposalStatus = (typeof actionProposalStatuses)[number];

export const actionStepStatuses = [
  "pending",
  "skipped",
  "ready",
  "executing",
  "completed",
  "failed",
  "reverted",
] as const;
export type ActionStepStatus = (typeof actionStepStatuses)[number];

export const actionRisks = ["low", "medium", "high"] as const;
export type ActionRisk = (typeof actionRisks)[number];

export const actionPhases = [
  "propose",
  "select",
  "approve",
  "preflight",
  "execute",
  "verify",
  "record",
  "revert",
  "cancel",
] as const;
export type ActionPhase = (typeof actionPhases)[number];

export interface ActionTarget {
  kind: string;
  id: string | null;
  path: string | null;
  label: string | null;
}

export interface ActionEvent {
  id: number;
  stepId: number | null;
  phase: ActionPhase;
  fromStatus: string | null;
  toStatus: string;
  detail: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** One concrete, reviewable change. `before`/`after` are what the operator sees. */
export interface ActionStep {
  id: number;
  proposalId: number;
  stepIndex: number;
  type: ActionType;
  status: ActionStepStatus;
  selected: boolean;
  summary: string;
  target: ActionTarget;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  preflight: Record<string, unknown>;
  execution: Record<string, unknown>;
  verification: Record<string, unknown>;
  revert: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActionProposalCounts {
  total: number;
  selected: number;
  pending: number;
  completed: number;
  failed: number;
  skipped: number;
  reverted: number;
}

export interface ActionProposal {
  id: number;
  proposalKey: string;
  type: ActionType;
  source: ActionSource;
  reason: string;
  status: ActionProposalStatus;
  risk: ActionRisk;
  requiresApproval: boolean;
  dryRun: boolean;
  allowCreateDirectories: boolean;
  reviewItemId: number | null;
  acquisitionJobId: number | null;
  downloadJobId: number | null;
  planHash: string;
  target: ActionTarget;
  evidence: Record<string, unknown>;
  approval: Record<string, unknown>;
  preflight: Record<string, unknown>;
  execution: Record<string, unknown>;
  verification: Record<string, unknown>;
  revert: Record<string, unknown>;
  postflight: Record<string, unknown>;
  retryCount: number;
  maxRetries: number;
  errorCode: string | null;
  errorMessage: string | null;
  counts: ActionProposalCounts;
  steps: ActionStep[];
  events: ActionEvent[];
  createdAt: string;
  approvedAt: string | null;
  executedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
}

export interface CreateActionStepInput {
  type: ActionType;
  summary?: string;
  target?: Partial<ActionTarget>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  selected?: boolean;
}

export interface CreateActionProposalInput {
  type: ActionType;
  source: ActionSource;
  reason: string;
  steps: CreateActionStepInput[];
  target?: Partial<ActionTarget>;
  evidence?: Record<string, unknown>;
  risk?: ActionRisk;
  dryRun?: boolean;
  allowCreateDirectories?: boolean;
  acquisitionJobId?: number | null;
  downloadJobId?: number | null;
  /** Pre-existing durable approval (legacy operations resolve one before planning). */
  reviewItemId?: number | null;
  /** Skips the proposed → approved gate when a caller already holds approval. */
  preApproved?: boolean;
  idempotencyKey?: string;
  maxRetries?: number;
}

/** Filesystem seam so tests and future adapters can supply their own effects. */
export interface ActionDependencies {
  stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  access(path: string, mode?: number): Promise<void>;
  copyFile(source: string, destination: string, mode?: number): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  inspect(path: string): Promise<Record<string, unknown>>;
}

export interface ActionHandlerContext {
  ownerId: string;
  proposal: ActionProposal;
  dependencies: ActionDependencies;
}

/**
 * An action family. Adding a capability to Archive Assistant means writing one
 * of these — never re-inventing approval, execution, or history.
 */
export interface ActionHandler {
  type: ActionType;
  /** False until the family is genuinely wired end to end. */
  supported: boolean;
  mutatesFiles: boolean;
  reversible: boolean;
  risk: ActionRisk;
  description: string;
  summarize(step: ActionStep): string;
  preflight(step: ActionStep, context: ActionHandlerContext): Promise<Record<string, unknown>>;
  execute(step: ActionStep, context: ActionHandlerContext): Promise<Record<string, unknown>>;
  verify(step: ActionStep, context: ActionHandlerContext): Promise<Record<string, unknown>>;
  revert(step: ActionStep, context: ActionHandlerContext): Promise<Record<string, unknown>>;
}

export function isActionType(value: unknown): value is ActionType {
  return typeof value === "string" && (actionTypes as readonly string[]).includes(value);
}

export function isActionSource(value: unknown): value is ActionSource {
  return typeof value === "string" && (actionSources as readonly string[]).includes(value);
}

export function asProposalStatus(value: unknown): ActionProposalStatus {
  return typeof value === "string" && (actionProposalStatuses as readonly string[]).includes(value)
    ? (value as ActionProposalStatus)
    : "draft";
}

export function asStepStatus(value: unknown): ActionStepStatus {
  return typeof value === "string" && (actionStepStatuses as readonly string[]).includes(value)
    ? (value as ActionStepStatus)
    : "pending";
}

export function asRisk(value: unknown): ActionRisk {
  return typeof value === "string" && (actionRisks as readonly string[]).includes(value)
    ? (value as ActionRisk)
    : "medium";
}

export function asPhase(value: unknown): ActionPhase {
  return typeof value === "string" && (actionPhases as readonly string[]).includes(value)
    ? (value as ActionPhase)
    : "record";
}
