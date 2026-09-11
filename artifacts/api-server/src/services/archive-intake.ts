/**
 * Archive intake: the seam between "a URL finished downloading" and "this file
 * is part of the archive".
 *
 * The intake layer deliberately owns no intelligence of its own. Every judgement
 * an intake item carries is read from the subsystem that already computes it:
 *
 * - inventory, checksums and identity   -> `services/archive.ts` (the scanner)
 * - encode verdicts and duplicate risk  -> `services/archive-quality.ts`
 * - the proposed archive path            -> `services/naming-intelligence.ts`
 * - validation, journaling and rollback  -> `services/archive-operations.ts`
 * - whether the archive still needs it   -> `services/acquisition-intelligence.ts`
 *
 * What intake adds is only the *hand-off*: a completed download becomes a
 * reviewable row, and promoting it goes through the same journaled operation
 * machinery that renames and restructurings already use. Nothing here moves a
 * file, deletes a file, or scores a file on its own.
 *
 * Capability deliberately deferred rather than worked around: the Safe Mutation
 * storage contract confines every journaled mutation to paths inside a
 * *configured archive volume*. A staging/download directory is not an archive
 * volume, so promoting a staged download is reported as `blocked` together with
 * the exact validation reason, instead of being done with a second, less safe
 * rename path. Operators who add their staging directory to the archive volumes
 * get a journaled, rollbackable promotion with no further changes here.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { archiveDb, readSettings, type SettingsRecord } from "../lib/archive-db";
import { getArchiveVolumes, isArchivePathWithin } from "./storage";
import { readArchiveInventory } from "./archive";
import { readJobs } from "./download-engine";
import { readRecordQualityReport } from "./archive-quality";
import { buildNamingProposals, namingProposalEvidenceKey, type ProposalRecord } from "./naming-intelligence";
import { readNormalizedMediaStates } from "./reconciliation";
import { listAcquisitionFindings } from "./acquisition-intelligence";
import {
  ArchiveMutationError,
  createOperation,
  dryRunMutation,
  executeOperation,
  readOperation,
  validateMutationPaths,
  type ArchiveOperationKind,
  type OperationPlan,
} from "./archive-operations";

export const INTAKE_DISPOSITIONS = [
  "file_missing",
  "not_inventoried",
  "already_in_archive",
  "blocked",
  "promotable",
] as const;

export type IntakeDisposition = (typeof INTAKE_DISPOSITIONS)[number];

/** Job states that can leave a finished or half-finished file on disk. */
const INTAKE_JOB_STATUSES = new Set([
  "downloaded",
  "processing",
  "verifying",
  "moving",
  "complete",
  "recovery_required",
  "failed",
]);

type StagedRecordRow = {
  id: number;
  path: string;
  filename: string;
  size_bytes: number | null;
  modified_at_ms: number | null;
  checksum: string | null;
  checksum_status: string | null;
  media_type: string | null;
  container: string | null;
  height: number | null;
  video_codec: string | null;
  duration_seconds: number | null;
  error_message: string | null;
};

function findStagedRecord(ownerId: string, filePath: string): StagedRecordRow | null {
  const row = archiveDb
    .prepare(
      `SELECT id, path, filename, size_bytes, modified_at_ms, checksum, checksum_status,
              media_type, container, height, video_codec, duration_seconds, error_message
         FROM file_record
        WHERE owner_id = ? AND path = ? AND scan_status = 'active'
        LIMIT 1`,
    )
    .get(ownerId, filePath) as StagedRecordRow | undefined;
  return row ?? null;
}

export type IntakeDuplicate = {
  fileRecordId: number;
  path: string;
  filename: string;
  /** `true` when the copy is byte-identical, which is what the checksum proves. */
  exact: boolean;
};

export type IntakeItem = {
  jobId: number;
  jobStatus: string;
  verification: string;
  title: string;
  sourceUrl: string;
  sourceSite: string | null;
  completedAt: string | null;
  errorMessage: string | null;

  /** Where the finished file lives now (final path, or still in staging). */
  stagedPath: string;
  fileExists: boolean;
  fileRecordId: number | null;
  sizeBytes: number | null;
  modifiedAtMs: number | null;
  checksum: string | null;
  checksumStatus: string | null;
  /** Whether `stagedPath` sits inside a configured archive volume. */
  insideArchiveVolume: boolean;

  /** The scanner's verdict for the staged file, reduced to what intake needs. */
  qualitySummary: string | null;
  qualityFindings: Array<{
    key: string;
    kind: string;
    severity: string;
    headline: string;
    reviewStatus: string;
    counterpartFileRecordId: number | null;
  }>;
  duplicates: IntakeDuplicate[];
  /** Normalized presence from reconciliation, or null when it has no state. */
  reconciliation: {
    archiveState: string;
    presentCount: number;
    expectedCount: number;
    identityKey: string | null;
  } | null;
  /** The acquisition need recorded for this identity, if the operator filed one. */
  acquisition: {
    findingId: number;
    recommendationStatus: string;
    priority: string;
    reviewStatus: string;
  } | null;
  namingProposal: {
    fileRecordId: number;
    proposedPath: string | null;
    patternId: string;
    confidence: string;
    operation: string;
    decisionStatus: string | null;
    collision: boolean;
  } | null;

  /** Where promotion would put the file, and whether the journal allows it. */
  proposedTargetPath: string | null;
  gate: { legal: boolean; code: string | null; reason: string | null };

  disposition: IntakeDisposition;
  nextAction: string;
};

function evidenceKeyFor(input: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * Every completed-or-stalled download, annotated with what the archive already
 * knows about the file it produced. Read-only: nothing here writes to disk or to
 * a table, so it is safe to call on every page load.
 */
export async function readIntakeItems(ownerId: string, settings: SettingsRecord = readSettings()) {
  const jobs = readJobs(ownerId).filter((job) => INTAKE_JOB_STATUSES.has(job.status));
  const volumes = getArchiveVolumes(settings);
  const { records, context } = readArchiveInventory(ownerId);
  // Only records that sit inside an archive volume get a naming proposal, which
  // is exactly why a staged download usually has none: its destination then
  // comes from the download job's own prepared path.
  const proposals = new Map<number, ProposalRecord>(
    (await buildNamingProposals(ownerId, settings)).map((proposal) => [proposal.fileRecordId, proposal]),
  );
  const normalizedStates = readNormalizedMediaStates(ownerId);
  const acquisitionFindings = listAcquisitionFindings(ownerId, { pageSize: 500 }).results;

  const items: IntakeItem[] = jobs.map((job): IntakeItem => {
    // A job that never reached verification still has the file it downloaded:
    // it is sitting in the temporary directory, and the operator needs to see
    // that before deciding anything.
    const stagedPath =
      job.finalPath?.trim() || (job.temporaryDirectory ? join(job.temporaryDirectory, job.finalFilename) : "");
    const record = stagedPath ? findStagedRecord(ownerId, stagedPath) : null;
    const fileExists = stagedPath ? existsSync(stagedPath) : false;
    const identityKey = record
      ? (records.find((candidate) => candidate.id === record.id)?.identityKey ?? null)
      : null;

    const report = record ? readRecordQualityReport(ownerId, record.id) : null;
    const duplicates: IntakeDuplicate[] = record?.checksum
      ? (context.indexes.checksum.get(record.checksum) ?? [])
          .filter((candidate) => candidate.id !== record.id && candidate.path !== record.path)
          .map((candidate) => ({
            fileRecordId: candidate.id,
            path: candidate.path,
            filename: basename(candidate.path),
            exact: true,
          }))
      : [];

    const naming = proposals.get(record?.id ?? -1) ?? null;
    // Intake promotes the file to the archive destination the download was
    // prepared for. A naming proposal is reported alongside it but never used as
    // the destination: layout inside the archive is the naming pipeline's
    // decision, gated on the operator accepting it, and letting intake jump that
    // queue would make two subsystems fight over the same path.
    const targetPath = job.destinationDirectory
      ? join(job.destinationDirectory, job.finalFilename)
      : (naming?.proposedPath ?? null);

    let gate: IntakeItem["gate"];
    if (!stagedPath) {
      gate = { legal: false, code: "no_staged_file", reason: "The download job never produced a file path." };
    } else if (!targetPath) {
      gate = {
        legal: false,
        code: "no_destination",
        reason: "No archive destination is available: the job recorded no destination directory and no naming proposal exists for the staged file.",
      };
    } else {
      try {
        validateMutationPaths(stagedPath, targetPath, settings);
        gate = { legal: true, code: null, reason: null };
      } catch (error) {
        if (error instanceof ArchiveMutationError) {
          gate = { legal: false, code: error.code, reason: error.message };
        } else {
          gate = {
            legal: false,
            code: "invalid",
            reason: error instanceof Error ? error.message : "The planned mutation was rejected.",
          };
        }
      }
    }

    const insideArchiveVolume = stagedPath
      ? volumes.some((volume) => isArchivePathWithin(stagedPath, volume.path))
      : false;

    let disposition: IntakeDisposition;
    let nextAction: string;
    if (!record) {
      // A promoted file leaves its staging slot empty on purpose. If the archive
      // now holds a record at the promotion target, saying "there is no file"
      // would be wrong, so that case is reported as already archived.
      const promotedRecord = targetPath ? records.find((candidate) => candidate.path === targetPath) : undefined;
      if (promotedRecord) {
        disposition = "already_in_archive";
        nextAction = `Already promoted: the archive records this content at ${promotedRecord.path}. Roll it back from the operation journal to stage it again.`;
      } else {
        disposition = fileExists ? "not_inventoried" : "file_missing";
        nextAction = fileExists
          ? "Run an archive scan so the staged file is inventoried, then review it here."
          : "There is no file to intake. Mock/demo downloads never write one; re-run this job with the real yt-dlp engine.";
      }
    } else if (duplicates.length > 0) {
      disposition = "already_in_archive";
      nextAction = "A byte-identical copy is already recorded in the archive. Resolve the duplicate finding first; intake never replaces media.";
    } else if (targetPath && resolve(targetPath) === resolve(stagedPath)) {
      // The download engine moves a verified file straight to its destination
      // today, so the "promotion" it would need is a no-op. Reporting that as a
      // blocked same-path mutation would read like a defect.
      disposition = "already_in_archive";
      nextAction = `Already at its archive destination (${stagedPath}); nothing needs to be promoted.`;
    } else if (!gate.legal) {
      disposition = "blocked";
      // The volume hint is only useful for the one rejection intake cannot fix:
      // a staged file that no archive volume contains. Other reasons (a
      // collision, an extension change, an identical path) are already complete
      // sentences and must not get advice bolted on.
      nextAction =
        gate.code === "outside_volume" || gate.code === "invalid_path"
          ? `${gate.reason} To promote a staged download safely, make its directory a configured archive volume so the journal can validate and roll the move back.`
          : (gate.reason ?? "The planned promotion was rejected.");
    } else {
      disposition = "promotable";
      nextAction = "Plan the promotion to review the collision and evidence checks, then apply it as a journaled archive operation.";
    }

    const state = identityKey
      ? normalizedStates.find((candidate) => candidate.identity.key === identityKey) ?? null
      : null;
    const need = identityKey
      ? acquisitionFindings.find((finding) => finding.need?.identity?.key === identityKey) ?? null
      : null;

    return {
      jobId: job.id,
      jobStatus: job.status,
      verification: job.verification,
      title: job.title,
      sourceUrl: job.sourceUrl,
      sourceSite: job.sourceSite,
      completedAt: job.completedAt,
      errorMessage: job.errorMessage,
      stagedPath,
      fileExists,
      fileRecordId: record?.id ?? null,
      sizeBytes: record?.size_bytes ?? null,
      modifiedAtMs: record?.modified_at_ms ?? null,
      checksum: record?.checksum ?? null,
      checksumStatus: record?.checksum_status ?? null,
      insideArchiveVolume,
      qualitySummary: report?.currentQualityLine ?? null,
      qualityFindings: (report?.findings ?? []).map((finding) => ({
        key: finding.key,
        kind: finding.kind,
        severity: finding.severity,
        headline: finding.headline,
        reviewStatus: finding.reviewStatus,
        counterpartFileRecordId: finding.counterpartFileRecordId,
      })),
      duplicates,
      reconciliation: state
        ? {
            archiveState: state.archiveState,
            presentCount: state.presentCount,
            expectedCount: state.expectedCount,
            identityKey,
          }
        : null,
      acquisition: need
        ? {
            findingId: need.id,
            recommendationStatus: need.recommendation.status,
            priority: need.recommendation.priority,
            reviewStatus: need.review.status,
          }
        : null,
      namingProposal: naming
        ? {
            fileRecordId: naming.fileRecordId,
            proposedPath: naming.proposedPath,
            patternId: naming.patternId,
            confidence: naming.confidence,
            operation: naming.operation,
            decisionStatus: naming.decisionStatus ?? null,
            collision: naming.collision,
          }
        : null,
      proposedTargetPath: targetPath,
      gate,
      disposition,
      nextAction,
    };
  });

  return {
    items,
    summary: {
      total: items.length,
      promotable: items.filter((item) => item.disposition === "promotable").length,
      blocked: items.filter((item) => item.disposition === "blocked").length,
      alreadyInArchive: items.filter((item) => item.disposition === "already_in_archive").length,
      awaitingInventory: items.filter((item) => item.disposition === "not_inventoried").length,
      fileMissing: items.filter((item) => item.disposition === "file_missing").length,
      withFindings: items.filter((item) => item.qualityFindings.length > 0).length,
    },
  };
}

export type IntakePlanResult = {
  item: IntakeItem;
  operation: ReturnType<typeof readOperation>;
  plan: (OperationPlan & { kind: ArchiveOperationKind }) | null;
  /**
   * The plan's failure reason, surfaced at the top level because the shared
   * `ArchiveOperationPlan` contract does not carry an error field.
   */
  planError: string | null;
};

/**
 * Turns one intake item into a journal entry plus a dry run. The operation is
 * created as `proposed`, never queued, so planning can never mutate the archive:
 * `applyIntakePromotion` is the only step that moves a file.
 */
export async function planIntakePromotion(
  ownerId: string,
  jobId: number,
  settings: SettingsRecord = readSettings(),
): Promise<IntakePlanResult> {
  const { items } = await readIntakeItems(ownerId, settings);
  const item = items.find((candidate) => candidate.jobId === jobId);
  if (!item) throw new ArchiveMutationError("state", `No intake item exists for download job ${jobId}.`);
  if (item.disposition !== "promotable" || !item.proposedTargetPath) {
    throw new ArchiveMutationError("state", item.nextAction);
  }

  const sourcePath = item.stagedPath;
  const targetPath = item.proposedTargetPath;
  const kind: ArchiveOperationKind =
    dirname(sourcePath).toLowerCase() === dirname(targetPath).toLowerCase() ? "rename" : "move";

  // When the naming engine already proposed this exact destination, reuse its
  // evidence key so the intake journal and the naming decision expire together.
  // Otherwise intake hashes its own evidence over the same fields the journal
  // already compares (path, size, modification time).
  const sourceEvidenceKey =
    item.namingProposal && item.namingProposal.proposedPath === targetPath
      ? namingProposalEvidenceKey({
          fileRecordId: item.fileRecordId ?? 0,
          sourcePath,
          sourceFilename: basename(sourcePath),
          sizeBytes: item.sizeBytes,
          modifiedAtMs: item.modifiedAtMs,
          patternId: item.namingProposal.patternId,
          confidence: item.namingProposal.confidence as "high" | "medium" | "low" | "uncertain",
          operation: item.namingProposal.operation as "rename" | "restructure" | "move" | "uncertain/no_action",
          collision: item.namingProposal.collision,
          proposedPath: targetPath,
        })
      : evidenceKeyFor({
          source: "intake",
          jobId: item.jobId,
          fileRecordId: item.fileRecordId,
          sourcePath,
          targetPath,
          sizeBytes: item.sizeBytes,
          modifiedAtMs: item.modifiedAtMs,
        });

  const operation = createOperation(
    ownerId,
    {
      kind,
      sourcePath,
      targetPath,
      fileRecordId: item.fileRecordId,
      sourceEvidenceKey,
      proposalEvidence: {
        source: "intake",
        jobId: item.jobId,
        title: item.title,
        sourceUrl: item.sourceUrl,
        sourceSite: item.sourceSite,
        verification: item.verification,
        checksum: item.checksum,
        checksumStatus: item.checksumStatus,
        qualitySummary: item.qualitySummary,
        findingKinds: item.qualityFindings.map((finding) => finding.kind),
        reconciliation: item.reconciliation,
        acquisitionFindingId: item.acquisition?.findingId ?? null,
      },
      expectedSizeBytes: item.sizeBytes,
      expectedModifiedAtMs: item.modifiedAtMs,
      initialStatus: "proposed",
    },
    settings,
  );

  const plan = await dryRunMutation(sourcePath, targetPath, ownerId, settings, {
    sizeBytes: item.sizeBytes,
    modifiedAtMs: item.modifiedAtMs,
  });

  return {
    item: { ...item, gate: { legal: plan.ok, code: plan.ok ? null : "dry_run", reason: plan.error } },
    operation,
    plan: { ...plan, kind },
    planError: plan.error,
  };
}

/**
 * Executes a planned intake operation. All of the safety behaviour - revalidation
 * against current settings, the size and mtime evidence checks, the refusal to
 * overwrite, creating and cleaning up directories, relocating the archive record
 * and invalidating the inventory cache - is `executeOperation`'s, and rollback
 * stays available through `POST /archive/operations/{id}/rollback`.
 */
export async function applyIntakePromotion(
  ownerId: string,
  jobId: number,
  operationId: number,
  settings: SettingsRecord = readSettings(),
) {
  const planned = readOperation(ownerId, operationId);
  if (!planned) throw new ArchiveMutationError("state", "Archive operation not found.");
  const { items } = await readIntakeItems(ownerId, settings);
  const item = items.find((candidate) => candidate.jobId === jobId);
  if (!item) throw new ArchiveMutationError("state", `No intake item exists for download job ${jobId}.`);
  // The journal entry has to describe the file that is actually staged right
  // now, or a stale plan could move something the operator never reviewed.
  if (planned.sourcePath !== item.stagedPath || planned.targetPath !== item.proposedTargetPath) {
    throw new ArchiveMutationError(
      "source_changed",
      "The staged file or its proposed destination changed after planning. Plan the promotion again before applying it.",
    );
  }

  const operation = await executeOperation(ownerId, operationId, settings);
  const refreshed = (await readIntakeItems(ownerId, settings)).items.find((candidate) => candidate.jobId === jobId) ?? null;
  return { operation, item: refreshed };
}
