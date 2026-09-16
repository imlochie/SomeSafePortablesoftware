/**
 * Naming intelligence → Action Layer.
 *
 * This is the reference implementation of the migration pattern: an
 * intelligence feature answers only "what action can resolve this finding?"
 * and hands concrete before/after changes to the action engine. It owns no
 * approval, execution, verification, or revert logic of its own.
 */
import { basename, dirname } from "node:path";
import { createActionProposal } from "./action-engine";
import type { ActionProposal, CreateActionStepInput } from "./action-engine";
import { readNamingProposals } from "./naming-intelligence";

export interface NamingActionFilters {
  confidence?: string;
  pattern?: string;
  mediaType?: string;
  volume?: string;
  /** Restrict the plan to specific naming-proposal file record ids. */
  fileRecordIds?: number[];
  /** Safety ceiling on how many renames a single proposal may contain. */
  limit?: number;
}

interface NamingProposalRow {
  fileRecordId: number;
  sourcePath: string;
  proposedPath: string | null;
  sourceFilename: string;
  proposedFilename: string | null;
  currentIdentity: Record<string, unknown> | null;
  proposedIdentity: Record<string, unknown> | null;
  patternId: string;
  confidence: string;
  operation: string;
  reason: string;
  evidence: string[];
  mediaType: string;
  volumeId: string;
  collision: boolean;
}

const actionableOperations = new Set(["rename", "restructure"]);

/**
 * A naming finding is only actionable when the intelligence layer produced an
 * executable destination. Everything else stays advisory.
 */
function isActionable(row: NamingProposalRow) {
  return actionableOperations.has(row.operation)
    && !row.collision
    && typeof row.proposedPath === "string"
    && row.proposedPath.trim().length > 0
    && row.proposedPath !== row.sourcePath;
}

/**
 * Seam over naming intelligence. Canonical archive volumes are Windows paths,
 * so tests inject a report instead of depending on the host platform.
 */
export type NamingProposalReader = (
  ownerId: string,
  filters: Record<string, unknown>,
) => Promise<{ results: unknown[] }>;

export interface NamingActionCandidates {
  summary: {
    inspected: number;
    actionable: number;
    selected: number;
    rename: number;
    move: number;
    skipped: number;
  };
  candidates: Array<{
    fileRecordId: number;
    type: "rename" | "move";
    sourcePath: string;
    destinationPath: string;
    sourceFilename: string;
    destinationFilename: string;
    confidence: string;
    patternId: string;
    reason: string;
    evidence: string[];
  }>;
}

/**
 * Preview what the action layer would propose, without creating anything.
 * Powers "what can I do about this?" before the operator commits to a review.
 */
export async function readNamingActionCandidates(
  ownerId: string,
  filters: NamingActionFilters = {},
  readProposals: NamingProposalReader = readNamingProposals as NamingProposalReader,
): Promise<NamingActionCandidates> {
  const report = await readProposals(ownerId, {
    pageSize: 500,
    confidence: filters.confidence,
    pattern: filters.pattern,
    mediaType: filters.mediaType,
    volume: filters.volume,
  });
  const rows = report.results as unknown as NamingProposalRow[];
  const requested = filters.fileRecordIds?.length ? new Set(filters.fileRecordIds) : null;
  const actionable = rows.filter(isActionable);
  const chosen = actionable.filter((row) => !requested || requested.has(row.fileRecordId));
  const limit = Math.max(1, Math.min(500, filters.limit ?? 200));
  const limited = chosen.slice(0, limit);

  const candidates = limited.map((row) => {
    const destinationPath = row.proposedPath as string;
    const type = dirname(destinationPath).toLowerCase() === dirname(row.sourcePath).toLowerCase()
      ? "rename" as const
      : "move" as const;
    return {
      fileRecordId: row.fileRecordId,
      type,
      sourcePath: row.sourcePath,
      destinationPath,
      sourceFilename: row.sourceFilename,
      destinationFilename: row.proposedFilename ?? basename(destinationPath),
      confidence: row.confidence,
      patternId: row.patternId,
      reason: row.reason,
      evidence: row.evidence ?? [],
    };
  });

  return {
    summary: {
      inspected: rows.length,
      actionable: actionable.length,
      selected: candidates.length,
      rename: candidates.filter((candidate) => candidate.type === "rename").length,
      move: candidates.filter((candidate) => candidate.type === "move").length,
      skipped: rows.length - actionable.length,
    },
    candidates,
  };
}

/**
 * Turn naming findings into one reviewable ActionProposal.
 *
 * The proposal is created in `proposed` state: nothing is approved, nothing is
 * preflighted, and no file is touched until the operator walks the rest of the
 * action lifecycle.
 */
export async function planNamingNormalization(
  ownerId: string,
  filters: NamingActionFilters = {},
  readProposals: NamingProposalReader = readNamingProposals as NamingProposalReader,
): Promise<ActionProposal> {
  const { candidates, summary } = await readNamingActionCandidates(ownerId, filters, readProposals);
  if (!candidates.length) {
    throw new Error("No actionable naming findings are available for this owner.");
  }

  const steps: CreateActionStepInput[] = candidates.map((candidate) => ({
    type: candidate.type,
    summary: `${candidate.sourceFilename} → ${candidate.destinationFilename}`,
    target: {
      kind: "file_record",
      id: String(candidate.fileRecordId),
      path: candidate.sourcePath,
      label: candidate.sourceFilename,
    },
    before: {
      path: candidate.sourcePath,
      filename: candidate.sourceFilename,
    },
    after: {
      path: candidate.destinationPath,
      filename: candidate.destinationFilename,
    },
  }));

  // A plan containing any cross-directory move is riskier than pure renames.
  const hasMoves = candidates.some((candidate) => candidate.type === "move");
  return createActionProposal(ownerId, {
    type: hasMoves ? "move" : "rename",
    source: "naming_intelligence",
    reason: `Normalize ${candidates.length} inconsistent filename(s) to the archive naming convention.`,
    risk: hasMoves ? "medium" : "low",
    target: {
      kind: "archive_naming",
      id: null,
      path: null,
      label: `${candidates.length} file(s)`,
    },
    evidence: {
      inspected: summary.inspected,
      actionable: summary.actionable,
      skipped: summary.skipped,
      filters: {
        confidence: filters.confidence ?? null,
        pattern: filters.pattern ?? null,
        mediaType: filters.mediaType ?? null,
        volume: filters.volume ?? null,
      },
      patterns: Array.from(new Set(candidates.map((candidate) => candidate.patternId))),
      confidences: Array.from(new Set(candidates.map((candidate) => candidate.confidence))),
      generatedAt: new Date().toISOString(),
    },
    steps,
  });
}
