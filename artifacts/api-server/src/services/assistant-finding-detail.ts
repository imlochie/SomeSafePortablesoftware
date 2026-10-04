import { readArchiveInventory, readArchiveScan } from "./archive";
import { listAcquisitionRecommendations, type AcquisitionRecommendation } from "./acquisition-intelligence";
import { readIdentityAudit } from "./identity-audit";
import { readNamingProposals } from "./naming-intelligence";
import {
  groupRecommendations,
  integrityRecommendation,
  type AssistantGroup,
  type AssistantRecommendation,
} from "./assistant-overview";
import { readSettings } from "../lib/archive-db";
import { readStorage } from "../routes/system";

export type AssistantFindingEvidence = {
  statement: string;
  source: string;
  sourceId: string | null;
  available: boolean;
  observedAt: string | null;
};

export type AssistantFindingReference = {
  kind: "archive_record" | "assistant" | "review" | "archive";
  id: string;
  label: string;
  href: string;
};

export type AssistantFindingDetail = {
  id: string;
  type: AssistantGroup["type"];
  state: AssistantGroup["state"];
  priority: AssistantGroup["priority"];
  title: string;
  explanation: string;
  evidence: AssistantFindingEvidence[];
  confidence: string;
  freshness: { label: string; observedAt: string | null; available: boolean };
  uncertainty: string[];
  blockers: string[];
  recommendedAction: string;
  consequence: string;
  references: AssistantFindingReference[];
};

function recommendationForAcquisition(item: AcquisitionRecommendation, storageStatus: string): AssistantRecommendation {
  return {
    id: `download:${item.id}`,
    type: "download",
    priority: storageStatus === "critical" ? "low" : item.priority,
    confidence: item.confidence,
    title: `Download ${item.title}`,
    explanation: item.blockers.length
      ? `The recommendation is blocked: ${item.blockers.join(" ")}`
      : storageStatus === "critical"
        ? "The media gap is known, but storage is critically constrained, so acquisition should wait until space is recovered."
        : "The archive/provider evidence indicates that this media is not currently available as a healthy local copy.",
    evidence: [
      `Recommendation status: ${item.status}`,
      ...(item.blockers.length ? item.blockers : [item.recommendedAction]),
    ],
    recommendedAction: item.recommendedAction,
    state: item.blockers.length ? "blocked" : "actionable",
    reviewItemId: item.reviewItemId,
    acquisitionIdentity: item.identity,
  };
}

async function focusedGroups(ownerId: string, findingId: string): Promise<AssistantGroup[]> {
  const groupParts = findingId.startsWith("group:") ? findingId.split(":") : [];
  const requestedType = groupParts[1];
  const requestedState = groupParts[2];

  if (requestedType === "integrity" || findingId.startsWith("integrity:") || findingId.startsWith("inspection:")) {
    const findings = readArchiveInventory(ownerId).records.map(integrityRecommendation).filter((item): item is AssistantRecommendation => Boolean(item));
    return groupRecommendations(findings).filter((group) => group.id === findingId || findings.some((item) => item.id === findingId));
  }

  if (requestedType === "rename" || findingId.startsWith("rename:")) {
    const naming = await readNamingProposals(ownerId, { page: 1, pageSize: 500 });
    const recommendations: AssistantRecommendation[] = naming.results.map((proposal) => {
      const confidence = String(proposal.confidence ?? "uncertain");
      return {
        id: `rename:${proposal.fileRecordId}`,
        type: "rename",
        priority: confidence === "high" && proposal.collision !== true ? "low" : "medium",
        confidence,
        title: `Review naming for ${proposal.sourceFilename ?? "archive file"}`,
        explanation: String(proposal.reason ?? "Naming intelligence produced a read-only proposal."),
        evidence: Array.isArray(proposal.evidence) ? proposal.evidence.map(String) : [],
        recommendedAction: proposal.proposedPath ? `Review the proposed path: ${proposal.proposedPath}` : "Leave unchanged until the naming ambiguity is resolved.",
        state: proposal.collision ? "blocked" : confidence === "low" || confidence === "uncertain" ? "uncertain" : "actionable",
        reviewItemId: null,
      };
    });
    return groupRecommendations(recommendations).filter((group) => group.id === findingId || recommendations.some((item) => item.id === findingId));
  }

  if (requestedType === "download" || findingId.startsWith("download:")) {
    const storage = readStorage(readSettings());
    const recommendations = listAcquisitionRecommendations(ownerId)
      .filter((item) => !["completed", "dismissed"].includes(item.status) && !item.acquisitionJobId)
      .map((item) => recommendationForAcquisition(item, storage.status));
    return groupRecommendations(recommendations).filter((group) => group.id === findingId || recommendations.some((item) => item.id === findingId));
  }

  if (requestedType === "identity") {
    const audit = await readIdentityAudit(ownerId, { page: 1, pageSize: 500, needsReview: true });
    const values = audit.results.filter((item) => item.auditType === groupParts.slice(2).join(":") || item.auditType === requestedState);
    if (!values.length) return [];
    const first = values[0];
    return [{
      id: findingId,
      type: "identity",
      state: "uncertain",
      priority: "medium",
      confidence: first.confidence,
      title: `${values.length} files need identity review`,
      explanation: first.reason,
      evidence: [...new Set(values.flatMap((item) => item.evidence))].slice(0, 8),
      recommendedAction: first.recommendedInterpretation,
      underlyingItemIds: values.map((item) => item.fileRecordId),
      itemCount: values.length,
    }];
  }

  if (requestedType === "duplicate") {
    const ids = groupParts.slice(2).map(Number).filter(Number.isInteger).sort((left, right) => left - right);
    const records = readArchiveInventory(ownerId).records.filter((record) => ids.includes(record.id));
    if (!records.length) return [];
    return [{
      id: findingId,
      type: "duplicate",
      state: "uncertain",
      priority: "medium",
      confidence: records.every((record) => record.checksum) ? "high" : "needs_verification",
      title: `${records[0].filename} duplicate group`,
      explanation: "These records share duplicate evidence, but interchangeability has not been assumed.",
      evidence: records.flatMap((record) => record.qualityDifferences).slice(0, 8),
      recommendedAction: "Review the copies and quality differences before deciding what to retain.",
      underlyingItemIds: ids,
      itemCount: ids.length,
    }];
  }

  return [];
}

function domainReference(group: AssistantGroup): AssistantFindingReference {
  const firstId = group.underlyingItemIds[0];
  if (["integrity", "duplicate", "quality", "identity"].includes(group.type)) {
    return { kind: "archive_record", id: firstId === undefined ? group.id : String(firstId), label: firstId === undefined ? "Open archive review" : `Open archive record #${firstId}`, href: firstId === undefined ? "/archive" : `/archive?record=${encodeURIComponent(String(firstId))}` };
  }
  if (group.type === "rename") return { kind: "archive", id: "naming_proposals", label: "Open naming proposals", href: "/archive?view=naming_proposals" };
  return { kind: "assistant", id: group.id, label: "Open the decision workspace", href: "/assistant" };
}

function uncertaintyFor(group: AssistantGroup, lastScan: string | null): string[] {
  const uncertainty: string[] = [];
  if (group.state === "blocked") uncertainty.push("The recommendation is blocked in the current state; this detail does not claim the blocker has been resolved.");
  if (group.state === "uncertain") uncertainty.push("Archive Assistant could not establish a conclusive result from the available evidence.");
  if (!lastScan) uncertainty.push("No completed archive scan timestamp is available for this finding.");
  if (!group.evidence.length) uncertainty.push("No supporting evidence was returned by the direct source read.");
  if (group.underlyingItemIds.length > 1) uncertainty.push("This finding aggregates multiple persisted records; the evidence is not attributed to one record in this read.");
  return uncertainty;
}

export async function readAssistantFindingDetail(ownerId: string, findingId: string): Promise<AssistantFindingDetail | null> {
  const groups = await focusedGroups(ownerId, findingId);
  const group = groups.find((candidate) => candidate.id === findingId) ?? groups[0];
  if (!group) return null;
  const scan = readArchiveScan(ownerId);
  const observedAt = scan.completedAt;
  const source = group.type === "integrity" ? "media_inspection" : group.type === "identity" ? "identity_audit" : group.type === "rename" ? "naming_proposal" : group.type === "download" ? "acquisition_recommendation" : "archive_comparison";
  const sourceId = group.underlyingItemIds.length === 1 ? String(group.underlyingItemIds[0]) : group.id;
  const evidence = group.evidence.map((statement) => ({ statement, source, sourceId, available: true, observedAt }));
  const uncertainty = uncertaintyFor(group, observedAt);
  return {
    id: group.id,
    type: group.type,
    state: group.state,
    priority: group.priority,
    title: group.title,
    explanation: group.explanation,
    evidence,
    confidence: group.confidence,
    freshness: { label: scan.status === "scanning" ? "scanning" : observedAt ? "known" : "unknown", observedAt, available: Boolean(observedAt) },
    uncertainty,
    blockers: group.state === "blocked" ? ["The direct source read reports this finding as blocked."] : [],
    recommendedAction: group.recommendedAction,
    consequence: "Reviewing this finding does not change files or start provider work. Any later action remains behind the existing review, approval, preflight, and confirmation boundaries.",
    references: [domainReference(group), { kind: "assistant", id: group.id, label: "Return to assistant findings", href: "/assistant" }],
  };
}
