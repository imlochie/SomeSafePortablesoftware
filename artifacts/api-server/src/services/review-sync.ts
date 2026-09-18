import { createHash } from "node:crypto";
import { readArchiveInventory } from "./archive";
import { readNamingProposals } from "./naming-intelligence";
import { ensureReviewItem } from "./review-queue";
import { classifyFinding, summariseSeverity, type FindingClassification } from "./finding-severity";

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
  let informationalFindings = 0;
  const classifications: FindingClassification[] = [];
  // Duplicate counterparts are needed to tell an exact SHA-256 duplicate from a
  // fingerprint-only match, which is the difference between a decision and an
  // observation.
  const checksumById = new Map(inventory.records.map((record) => [record.id, record.checksum]));
  for (const record of inventory.records) {
    if (record.reviewStatus === "not_applicable") continue;
    const classification = classifyFinding({
      qualityStatus: record.qualityStatus,
      checksum: record.checksum,
      duplicateOfId: record.duplicateOfId,
      duplicateChecksum: record.duplicateOfId === null
        ? null
        : checksumById.get(record.duplicateOfId) ?? null,
      qualityDifferences: record.qualityDifferences,
      integrityClassification: record.integrityClassification,
    });
    classifications.push(classification);
    // Informational findings remain queryable through the archive inventory.
    // They are simply not placed in front of the operator as decisions, which
    // is what made the review queue unusable.
    if (!classification.reviewRequired) {
      informationalFindings += 1;
      continue;
    }
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
        severity: classification.severity,
        confidence: classification.confidence,
        severityReason: classification.reason,
        blockers: [],
      },
    });
    archiveFindingItems += 1;
  }

  for (const providerOnly of inventory.plexOnly) {
    ensureReviewItem(ownerId, {
      kind: "archive_finding",
      subjectKey: `provider-only:${providerOnly.provider}:${providerOnly.ratingKey}`,
      title: `${providerOnly.providerLabel} item is not in the archive: ${providerOnly.title}`,
      payload: {
        classification: "plex_only",
        provider: providerOnly.provider,
        providerLabel: providerOnly.providerLabel,
        ratingKey: providerOnly.ratingKey,
        title: providerOnly.title,
        year: providerOnly.year,
        itemType: providerOnly.itemType,
        summary: providerOnly.qualitySummary,
        severity: "medium",
        confidence: "high",
        blockers: ["A local archive file was not found for this provider item."],
      },
    });
    archiveFindingItems += 1;
  }

  return {
    namingItems,
    archiveFindingItems,
    informationalFindings,
    severity: summariseSeverity(classifications),
    total: namingItems + archiveFindingItems,
  };
}