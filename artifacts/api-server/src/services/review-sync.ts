import { createHash } from "node:crypto";
import { readArchiveInventory } from "./archive";
import { readNamingProposals } from "./naming-intelligence";
import { ensureReviewItem } from "./review-queue";

function evidenceHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function syncControlPlaneReviewItems(ownerId: string) {
  const naming = await readNamingProposals(ownerId, { page: 1, pageSize: 500 });
  let namingItems = 0;
  for (const proposal of naming.results) {
    const fileRecordId = Number(proposal.fileRecordId);
    const sourcePath = String(proposal.sourcePath ?? "");
    const proposedPath = typeof proposal.proposedPath === "string" ? proposal.proposedPath : null;
    const operation = String(proposal.operation ?? "uncertain/no_action");
    const evidence = Array.isArray(proposal.evidence) ? proposal.evidence : [];
    const evidenceKey = evidenceHash({
      fileRecordId,
      proposedPath,
      operation,
      confidence: proposal.confidence,
      evidence,
      collision: proposal.collision,
    });
    ensureReviewItem(ownerId, {
      kind: "naming_proposal",
      subjectKey: `naming:${fileRecordId}:${evidenceKey}`,
      title: `Review naming for ${String(proposal.sourceFilename ?? `record ${fileRecordId}`)}`,
      payload: {
        fileRecordId,
        sourcePath,
        destinationPath: proposedPath,
        action: operation === "rename" ? "rename" : operation === "restructure" ? "move" : null,
        operation,
        confidence: proposal.confidence,
        reason: proposal.reason,
        evidence,
        collision: proposal.collision === true,
        blockers: [
          ...(proposal.collision === true ? ["The proposed destination collides with an existing archive path."] : []),
          ...(!proposedPath ? ["No executable destination was produced by naming intelligence."] : []),
        ],
        evidenceKey,
        generationSemantics: "read_only",
      },
    });
    namingItems += 1;
  }

  const inventory = readArchiveInventory(ownerId);
  let archiveFindingItems = 0;
  for (const record of inventory.records) {
    if (record.reviewStatus === "not_applicable") continue;
    ensureReviewItem(ownerId, {
      kind: "archive_finding",
      subjectKey: `archive-finding:${record.id}:${record.qualityStatus}:${record.reviewEvidenceKey}`,
      title: `Review ${record.filename}`,
      payload: {
        fileRecordId: record.id,
        archiveItemId: record.archiveItemId,
        sourcePath: record.path,
        qualityStatus: record.qualityStatus,
        qualitySummary: record.qualitySummary,
        qualityDifferences: record.qualityDifferences,
        duplicateOfId: record.duplicateOfId,
        plexMatch: record.plexMatch,
        checksum: record.checksum,
        evidenceKey: record.reviewEvidenceKey,
        archiveReviewStatus: record.reviewStatus,
        archiveReviewNote: record.reviewNote,
        blockers: [],
      },
    });
    archiveFindingItems += 1;
  }

  return {
    namingItems,
    archiveFindingItems,
    total: namingItems + archiveFindingItems,
  };
}