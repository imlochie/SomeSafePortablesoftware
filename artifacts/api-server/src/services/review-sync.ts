import { createHash } from "node:crypto";
import { readArchiveInventory } from "./archive";
import { readNamingProposals } from "./naming-intelligence";
import { ensureReviewItem, supersedeReviewItems } from "./review-queue";
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
  // A provider-only relationship has a stable identity even as its evidence
  // changes. Supersede active observations that are absent from this complete
  // persisted snapshot, but never infer absence from a failed refresh: this
  // function only consumes the provider inventory already persisted by refresh.
  const currentProviderOnlySubjects = new Set(
    inventory.plexOnly.map((item) => `provider-only:${item.provider}:${item.ratingKey}`),
  );
  supersedeReviewItems(ownerId, "provider-only:", currentProviderOnlySubjects, "A later provider snapshot no longer reports this item as provider-only.");
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
    const subjectKey = `archive-finding:${record.id}`;
    const currentArchiveSubjects = classification.reviewRequired ? new Set([subjectKey]) : new Set<string>();
    supersedeReviewItems(ownerId, `archive-finding:${record.id}`, currentArchiveSubjects, classification.reviewRequired
      ? "A later archive observation superseded this finding evidence."
      : "A later archive observation resolved this finding.");
    // Informational findings remain queryable through the archive inventory.
    // They are simply not placed in front of the operator as decisions, which
    // is what made the review queue unusable.
    if (!classification.reviewRequired) {
      informationalFindings += 1;
      continue;
    }
    ensureReviewItem(ownerId, {
      kind: "archive_finding",
      subjectKey,
      title: `Review ${record.filename}`,
      payload: {
        classification: ["lower_quality_version", "higher_quality_available"].includes(record.qualityStatus)
          ? "quality_conflict"
          : record.qualityStatus,
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