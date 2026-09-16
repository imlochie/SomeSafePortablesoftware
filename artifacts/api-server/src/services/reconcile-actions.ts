/**
 * Reconciliation intelligence → Action Layer.
 *
 * The second family to go through the engine, and deliberately the least
 * file-shaped one: reconciling records a confirmed identity link between a
 * local file and a Plex item. Nothing on disk changes.
 *
 * It follows the same contract as naming-actions.ts — answer only "what action
 * would resolve this finding?" and hand concrete before/after state to the
 * engine. Approval, execution, verification and revert stay in the engine.
 */
import { createActionProposal } from "./action-engine";
import type { ActionProposal, CreateActionStepInput } from "./action-engine";
import { readReconciliationReport } from "./reconciliation";

export interface ReconcileActionFilters {
  /** Restrict the plan to specific local file record ids. */
  fileRecordIds?: number[];
  /** Safety ceiling on how many links a single proposal may contain. */
  limit?: number;
}

/**
 * Seam over the reconciliation report, mirroring naming-actions'
 * NamingProposalReader so tests can inject a report instead of depending on a
 * populated Plex snapshot.
 */
export type ReconciliationReader = (
  ownerId: string,
  page?: number,
  pageSize?: number,
) => Promise<{ summary: Record<string, unknown>; results: unknown[] }>;

interface ReconciliationRow {
  classification: string;
  matchingStrategy: string;
  candidateCount: number;
  local: {
    fileRecordId: number;
    path: string;
    relativePath: string;
    mediaType: string | null;
    identity: Record<string, unknown> | null;
  } | null;
  plex: {
    ratingKey: string;
    title: string;
    year: number | null;
    libraryName: string;
    itemType: string;
    identity: Record<string, unknown> | null;
  } | null;
  quality: { status: string; differences: unknown[] };
}

/**
 * Only an unambiguous single-candidate match may become a reconcile step.
 *
 * `uncertain` means the observer found several plausible Plex items; asking the
 * operator to rubber-stamp a guess would be exactly the "AI decides, human
 * clicks yes" pattern we are avoiding. Those stay findings, not actions.
 */
function isActionable(row: ReconciliationRow) {
  return row.candidateCount === 1
    && row.local !== null
    && row.plex !== null
    && (row.classification === "matched" || row.classification === "quality_conflict");
}

function identityKeyOf(row: ReconciliationRow) {
  const identity = row.local?.identity ?? row.plex?.identity ?? {};
  const show = identity.show ?? null;
  if (show) return `${String(show)}:${String(identity.season ?? "")}:${String(identity.episode ?? "")}`;
  return `${String(identity.title ?? "")}:${String(identity.year ?? "")}`;
}

export interface ReconcileActionCandidates {
  summary: {
    inspected: number;
    actionable: number;
    selected: number;
    matched: number;
    qualityConflict: number;
    uncertain: number;
    skipped: number;
  };
  candidates: Array<{
    fileRecordId: number;
    ratingKey: string;
    identityKey: string;
    localPath: string;
    localLabel: string;
    plexTitle: string;
    plexLibrary: string;
    matchingStrategy: string;
    classification: string;
    qualityStatus: string;
  }>;
}

/**
 * Preview what the action layer would propose, without creating anything.
 * Powers "what can I do about this?" for the reconciliation view.
 */
export async function readReconcileActionCandidates(
  ownerId: string,
  filters: ReconcileActionFilters = {},
  readReport: ReconciliationReader = readReconciliationReport as ReconciliationReader,
): Promise<ReconcileActionCandidates> {
  const report = await readReport(ownerId, 1, 500);
  const rows = report.results as unknown as ReconciliationRow[];
  const requested = filters.fileRecordIds?.length ? new Set(filters.fileRecordIds) : null;
  const actionable = rows.filter(isActionable);
  const chosen = actionable.filter((row) =>
    !requested || (row.local && requested.has(row.local.fileRecordId)));
  const limit = Math.max(1, Math.min(500, filters.limit ?? 200));
  const limited = chosen.slice(0, limit);

  const candidates = limited.map((row) => {
    const local = row.local!;
    const plex = row.plex!;
    return {
      fileRecordId: local.fileRecordId,
      ratingKey: plex.ratingKey,
      identityKey: identityKeyOf(row),
      localPath: local.path,
      localLabel: local.relativePath || local.path,
      plexTitle: plex.year ? `${plex.title} (${plex.year})` : plex.title,
      plexLibrary: plex.libraryName,
      matchingStrategy: row.matchingStrategy,
      classification: row.classification,
      qualityStatus: row.quality?.status ?? "not_compared",
    };
  });

  return {
    summary: {
      inspected: rows.length,
      actionable: actionable.length,
      selected: candidates.length,
      matched: rows.filter((row) => row.classification === "matched").length,
      qualityConflict: rows.filter((row) => row.classification === "quality_conflict").length,
      // Surfaced explicitly so the UI can say why some findings are not offered.
      uncertain: rows.filter((row) => row.classification === "uncertain").length,
      skipped: rows.length - actionable.length,
    },
    candidates,
  };
}

/**
 * Turn reconciliation findings into one reviewable ActionProposal.
 *
 * Created in `proposed` state: nothing is approved and no record is written
 * until the operator walks the rest of the action lifecycle.
 */
export async function planReconciliation(
  ownerId: string,
  filters: ReconcileActionFilters = {},
  readReport: ReconciliationReader = readReconciliationReport as ReconciliationReader,
): Promise<ActionProposal> {
  const { candidates, summary } = await readReconcileActionCandidates(ownerId, filters, readReport);
  if (!candidates.length) {
    throw new Error("No unambiguous reconciliation matches are available for this owner.");
  }

  const steps: CreateActionStepInput[] = candidates.map((candidate) => ({
    type: "reconcile",
    summary: `${candidate.localLabel} ⇄ ${candidate.plexTitle}`,
    target: {
      kind: "file_record",
      id: String(candidate.fileRecordId),
      path: candidate.localPath,
      label: candidate.localLabel,
    },
    // "before" is the unlinked local file; "after" is the confirmed link.
    // There is no path on the right-hand side — the review surface has to
    // render an identity, not a filename.
    before: {
      fileRecordId: candidate.fileRecordId,
      label: candidate.localLabel,
      path: candidate.localPath,
      linked: false,
      matchingStrategy: candidate.matchingStrategy,
      evidence: {
        classification: candidate.classification,
        matchingStrategy: candidate.matchingStrategy,
        quality: candidate.qualityStatus,
      },
    },
    after: {
      ratingKey: candidate.ratingKey,
      identityKey: candidate.identityKey,
      label: candidate.plexTitle,
      title: candidate.plexTitle,
      library: candidate.plexLibrary,
      linked: true,
    },
  }));

  return createActionProposal(ownerId, {
    type: "reconcile",
    source: "reconciliation",
    reason: `Confirm ${candidates.length} archive-to-Plex identity link(s).`,
    risk: "low",
    target: {
      kind: "archive_reconciliation",
      id: null,
      path: null,
      label: `${candidates.length} match(es)`,
    },
    evidence: {
      inspected: summary.inspected,
      actionable: summary.actionable,
      skipped: summary.skipped,
      uncertain: summary.uncertain,
      qualityConflict: summary.qualityConflict,
      patterns: Array.from(new Set(candidates.map((candidate) => candidate.matchingStrategy))),
      confidences: Array.from(new Set(candidates.map((candidate) => candidate.classification))),
      generatedAt: new Date().toISOString(),
    },
    steps,
  });
}
