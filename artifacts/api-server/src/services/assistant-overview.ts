import { readArchiveInventory, readArchiveScan } from "./archive";
import { listAcquisitionRecommendations } from "./acquisition-intelligence";
import { readNamingProposals } from "./naming-intelligence";
import { archiveDb } from "../lib/archive-db";

export const assistantPriorities = ["critical", "high", "medium", "low", "info"] as const;
export type AssistantPriority = (typeof assistantPriorities)[number];
export type AssistantRecommendationType = "download" | "integrity" | "rename" | "duplicate" | "identity" | "quality";

export interface AssistantRecommendation {
  id: string;
  type: AssistantRecommendationType;
  priority: AssistantPriority;
  confidence: string;
  title: string;
  explanation: string;
  evidence: string[];
  recommendedAction: string;
  state: string;
  reviewItemId: number | null;
}

function priorityRank(priority: AssistantPriority) {
  return assistantPriorities.indexOf(priority);
}

function integrityRecommendation(record: any): AssistantRecommendation | null {
  if (record.integrityClassification === "corrupt_or_malformed_container") {
    return {
      id: `integrity:${record.id}`,
      type: "integrity",
      priority: "high",
      confidence: "high",
      title: `${record.filename} may be corrupt`,
      explanation: "Container inspection failed in a way that is consistent with a malformed or corrupt media file.",
      evidence: [record.integritySummary ?? "Media inspection classified this file as corrupt or malformed."],
      recommendedAction: "Compare with another copy before replacing it.",
      state: record.reviewStatus,
      reviewItemId: null,
    };
  }
  if (record.integrityClassification === "inspection_unavailable") {
    return {
      id: `inspection:${record.id}`,
      type: "integrity",
      priority: "medium",
      confidence: "needs_verification",
      title: `${record.filename} could not be inspected`,
      explanation: "The local node could not reliably inspect this file; this does not by itself prove corruption.",
      evidence: [record.integritySummary ?? "Media inspection was unavailable."],
      recommendedAction: "Check the file path, permissions, and media tools before deciding what to do.",
      state: record.reviewStatus,
      reviewItemId: null,
    };
  }
  return null;
}

export async function readAssistantOverview(ownerId: string) {
  const [inventory, scan, naming] = await Promise.all([
    Promise.resolve(readArchiveInventory(ownerId)),
    Promise.resolve(readArchiveScan(ownerId)),
    readNamingProposals(ownerId, { page: 1, pageSize: 500 }),
  ]);
  const acquisition = listAcquisitionRecommendations(ownerId);
  const recommendations: AssistantRecommendation[] = [];

  for (const item of acquisition) {
    if (item.status === "completed" || item.status === "dismissed" || item.acquisitionJobId) continue;
    recommendations.push({
      id: `download:${item.id}`,
      type: "download",
      priority: item.priority,
      confidence: item.confidence,
      title: `Download ${item.title}`,
      explanation: item.blockers.length
        ? `The recommendation is blocked: ${item.blockers.join(" ")}`
        : "The archive/provider evidence indicates that this media is not currently available as a healthy local copy.",
      evidence: [
        `Recommendation status: ${item.status}`,
        ...(item.blockers.length ? item.blockers : [item.recommendedAction]),
      ],
      recommendedAction: item.recommendedAction,
      state: item.status,
      reviewItemId: item.reviewItemId,
    });
  }

  for (const record of inventory.records) {
    const finding = integrityRecommendation(record);
    if (finding) recommendations.push(finding);
  }

  for (const proposal of naming.results) {
    const confidence = String(proposal.confidence ?? "uncertain");
    const priority: AssistantPriority = confidence === "high" && proposal.collision !== true ? "low" : "medium";
    recommendations.push({
      id: `rename:${proposal.fileRecordId}`,
      type: "rename",
      priority,
      confidence,
      title: `Review naming for ${proposal.sourceFilename ?? "archive file"}`,
      explanation: String(proposal.reason ?? "Naming intelligence produced a read-only proposal."),
      evidence: Array.isArray(proposal.evidence) ? proposal.evidence.map(String) : [],
      recommendedAction: proposal.proposedPath
        ? `Review the proposed path: ${proposal.proposedPath}`
        : "Leave unchanged until the naming ambiguity is resolved.",
      state: proposal.collision ? "blocked" : "proposal",
      reviewItemId: null,
    });
  }

  recommendations.sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority));
  const attention = recommendations.filter((item) => item.priority !== "info").slice(0, 20);
  const counts = recommendations.reduce<Record<AssistantPriority, number>>(
    (result, item) => ({ ...result, [item.priority]: result[item.priority] + 1 }),
    { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  );
  const activeWork = archiveDb.prepare("SELECT COUNT(*) AS count FROM acquisition_job WHERE owner_id = ? AND state IN ('planned', 'downloading', 'processing', 'verifying')").get(ownerId) as { count: number };

  return {
    summary: {
      health: counts.critical || counts.high ? "attention_required" : recommendations.length ? "mostly_healthy" : "healthy",
      attentionCount: attention.length,
      counts,
      lastScan: scan.completedAt,
      freshness: scan.status === "scanning" ? "scanning" : scan.completedAt ? "known" : "unknown",
    },
    attention,
    recommendations,
    informational: [
      ...(scan.status === "scanning" ? ["An archive scan is currently running."] : []),
      ...(activeWork.count ? [`${activeWork.count} acquisition job(s) are active.`] : []),
    ],
    activeWork: { scanStatus: scan.status, acquisitionJobs: activeWork.count },
  };
}
