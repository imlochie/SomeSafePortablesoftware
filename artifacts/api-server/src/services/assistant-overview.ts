import { readArchiveInventory, readArchiveScan } from "./archive";
import { listAcquisitionRecommendations, type AcquisitionIdentity } from "./acquisition-intelligence";
import { readNamingProposals } from "./naming-intelligence";
import { readIdentityAudit } from "./identity-audit";
import { archiveDb, readSettings } from "../lib/archive-db";
import { readStorage } from "../routes/system";

export const assistantPriorities = ["critical", "high", "medium", "low", "info"] as const;
export type AssistantPriority = (typeof assistantPriorities)[number];
export type AssistantRecommendationType = "download" | "integrity" | "rename" | "duplicate" | "identity" | "quality";
export type AssistantGroupState = "actionable" | "blocked" | "uncertain" | "informational" | "resolved";

export interface AssistantGroup {
  id: string;
  type: AssistantRecommendationType;
  state: AssistantGroupState;
  priority: AssistantPriority;
  confidence: string;
  title: string;
  explanation: string;
  evidence: string[];
  recommendedAction: string;
  underlyingItemIds: number[];
  itemCount: number;
}

export interface AssistantRecommendation {
  id: string;
  type: AssistantRecommendationType;
  priority: AssistantPriority;
  confidence: string;
  title: string;
  explanation: string;
  evidence: string[];
  recommendedAction: string;
  state: "actionable" | "blocked" | "uncertain" | "informational" | "resolved";
  reviewItemId: number | null;
  acquisitionIdentity?: AcquisitionIdentity | null;
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
      state: "actionable",
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
      state: "actionable",
      reviewItemId: null,
    };
  }
  return null;
}

export function groupRecommendations(recommendations: AssistantRecommendation[]): AssistantGroup[] {
  const groups = new Map<string, AssistantRecommendation[]>();
  for (const item of recommendations) {
    const identity = item.acquisitionIdentity;
    const key = item.type === "download"
      ? identity?.seriesId && identity.seasonNumber !== undefined
        ? `${item.type}:${item.state}:series:${identity.seriesId}:season:${identity.seasonNumber}`
        : `${item.type}:${item.state}:${item.title.replace(/^Download /, "").toLowerCase()}`
      : `${item.type}:${item.state}`;
    const values = groups.get(key) ?? [];
    values.push(item);
    groups.set(key, values);
  }
  return [...groups.entries()].map(([id, items]) => {
    const first = items[0];
    const identity = first.acquisitionIdentity;
    const semanticSeasonTitle = first.type === "download"
      && identity?.seriesTitle
      && identity.seasonNumber !== undefined
      ? `${identity.seriesTitle} — Season ${identity.seasonNumber}: ${items.length} missing episode${items.length === 1 ? "" : "s"}`
      : null;
    const title = semanticSeasonTitle
      ?? (items.length === 1
        ? first.title
        : first.type === "download"
          ? `${items.length} acquisition candidates`
        : first.type === "integrity"
          ? `${items.length} integrity findings`
          : first.type === "rename"
            ? `${items.length} naming suggestions`
            : `${items.length} ${first.type} findings`);
    return {
      id: `group:${id}`,
      type: first.type,
      state: first.state,
      priority: first.priority,
      confidence: first.confidence,
      title,
      explanation: items.length === 1
        ? first.explanation
        : `${items.length} related items were grouped so the archive is not presented as isolated rows.`,
      evidence: [...new Set(items.flatMap((item) => item.evidence))].slice(0, 8),
      recommendedAction: first.recommendedAction,
      underlyingItemIds: items.flatMap((item) => {
        const idValue = item.reviewItemId ?? Number(item.id.split(":").at(-1));
        return Number.isInteger(idValue) ? [idValue] : [];
      }).sort((left, right) => left - right),
      itemCount: items.length,
    };
  }).sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.title.localeCompare(right.title));
}

export async function readAssistantOverview(ownerId: string) {
  const [inventory, scan, naming, identityAudit] = await Promise.all([
    Promise.resolve(readArchiveInventory(ownerId)),
    Promise.resolve(readArchiveScan(ownerId)),
    readNamingProposals(ownerId, { page: 1, pageSize: 500 }),
    readIdentityAudit(ownerId, { page: 1, pageSize: 500, needsReview: true }),
  ]);
  const acquisition = listAcquisitionRecommendations(ownerId);
  const storage = readStorage(readSettings());
  const recommendations: AssistantRecommendation[] = [];

  for (const item of acquisition) {
    if (item.status === "completed" || item.status === "dismissed" || item.acquisitionJobId) continue;
    recommendations.push({
      id: `download:${item.id}`,
      type: "download",
      priority: storage.status === "critical" ? "low" : item.priority,
      confidence: item.confidence,
      title: `Download ${item.title}`,
      explanation: item.blockers.length
        ? `The recommendation is blocked: ${item.blockers.join(" ")}`
        : storage.status === "critical"
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
      state: proposal.collision ? "blocked" : confidence === "low" || confidence === "uncertain" ? "uncertain" : "actionable",
      reviewItemId: null,
    });
  }

  recommendations.sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority));
  const blocked = recommendations.filter((item) => item.state === "blocked");
  const uncertain = recommendations.filter((item) => item.state === "uncertain");
  const attention = recommendations.filter((item) => item.state === "actionable" && item.priority !== "info").slice(0, 20);
  const counts = attention.reduce<Record<AssistantPriority, number>>(
    (result, item) => ({ ...result, [item.priority]: result[item.priority] + 1 }),
    { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  );
  const groups = groupRecommendations(recommendations);
  const duplicateRows = inventory.records.filter((record) => record.qualityStatus === "duplicate" && record.duplicateOfId !== null);
  const duplicateGroups = [...new Map(duplicateRows.map((record) => {
    const ids = [record.id, record.duplicateOfId!].sort((left, right) => left - right);
    return [ids.join(":"), { ids, records: [record] }];
  })).values()].map(({ ids, records }) => ({
    id: `group:duplicate:${ids.join(":")}`,
    type: "duplicate" as const,
    state: "uncertain" as const,
    priority: "medium" as const,
    confidence: "needs_verification",
    title: `${records[0].filename} duplicate group`,
    explanation: "These records share duplicate evidence, but interchangeability has not been assumed.",
    evidence: records.flatMap((record) => record.qualityDifferences).slice(0, 8),
    recommendedAction: "Review the copies and quality differences before deciding what to retain.",
    underlyingItemIds: ids,
    itemCount: ids.length,
  }));
  const identityGroups = [...new Map(identityAudit.results.map((result) => {
    const key = result.auditType;
    const values = identityAudit.results.filter((item) => item.auditType === key);
    return [key, {
      id: `group:identity:${key}`,
      type: "identity" as const,
      state: "uncertain" as const,
      priority: "medium" as const,
      confidence: result.confidence,
      title: `${values.length} files need identity review`,
      explanation: result.reason,
      evidence: [...new Set(values.flatMap((item) => item.evidence))].slice(0, 8),
      recommendedAction: result.recommendedInterpretation,
      underlyingItemIds: values.map((item) => item.fileRecordId),
      itemCount: values.length,
    }];
  })).values()];
  const semanticGroups = [...groups, ...duplicateGroups, ...identityGroups]
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.title.localeCompare(right.title));
  const activeWork = archiveDb.prepare("SELECT COUNT(*) AS count FROM acquisition_job WHERE owner_id = ? AND state IN ('planned', 'downloading', 'processing', 'verifying')").get(ownerId) as { count: number };

  return {
    summary: {
      health: counts.critical || counts.high ? "attention_required" : recommendations.length ? "mostly_healthy" : "healthy",
      attentionCount: attention.length,
      counts,
      blockedCount: blocked.length,
      uncertainCount: uncertain.length,
      lastScan: scan.completedAt,
      freshness: scan.status === "scanning" ? "scanning" : scan.completedAt ? "known" : "unknown",
    },
    attention,
    recommendations,
    groups: semanticGroups,
    blocked,
    uncertain,
    informational: [
      ...(scan.status === "scanning" ? ["An archive scan is currently running."] : []),
      ...(activeWork.count ? [`${activeWork.count} acquisition job(s) are active.`] : []),
    ],
    activeWork: { scanStatus: scan.status, acquisitionJobs: activeWork.count },
  };
}
