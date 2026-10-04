import { readAssistantOverview, type AssistantGroup, type AssistantRecommendation } from "./assistant-overview";

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
  freshness: {
    label: string;
    observedAt: string | null;
    available: boolean;
  };
  uncertainty: string[];
  blockers: string[];
  recommendedAction: string;
  consequence: string;
  references: AssistantFindingReference[];
};

function domainReference(group: AssistantGroup): AssistantFindingReference {
  const firstId = group.underlyingItemIds[0];
  if (group.type === "integrity" || group.type === "duplicate" || group.type === "quality" || group.type === "identity") {
    return {
      kind: "archive_record",
      id: firstId === undefined ? group.id : String(firstId),
      label: firstId === undefined ? "Open archive review" : `Open archive record #${firstId}`,
      href: firstId === undefined ? "/archive" : `/archive?record=${encodeURIComponent(String(firstId))}`,
    };
  }
  if (group.type === "rename") {
    return { kind: "archive", id: "naming_proposals", label: "Open naming proposals", href: "/archive?view=naming_proposals" };
  }
  return { kind: "assistant", id: group.id, label: "Open the decision workspace", href: "/assistant" };
}

function uncertaintyFor(group: AssistantGroup, lastScan: string | null): string[] {
  const uncertainty: string[] = [];
  if (group.state === "blocked") uncertainty.push("The recommendation is blocked in the current state; this detail does not claim the blocker has been resolved.");
  if (group.state === "uncertain") uncertainty.push("Archive Assistant could not establish a conclusive result from the available evidence.");
  if (!lastScan) uncertainty.push("No completed archive scan timestamp is available for this briefing.");
  if (!group.evidence.length) uncertainty.push("No supporting evidence was returned by the assistant overview.");
  return uncertainty;
}

function recommendationAsGroup(recommendation: AssistantRecommendation): AssistantGroup {
  return {
    id: recommendation.id,
    type: recommendation.type,
    state: recommendation.state,
    priority: recommendation.priority,
    confidence: recommendation.confidence,
    title: recommendation.title,
    explanation: recommendation.explanation,
    evidence: recommendation.evidence,
    recommendedAction: recommendation.recommendedAction,
    underlyingItemIds: [],
    itemCount: 1,
  };
}

export async function readAssistantFindingDetail(ownerId: string, findingId: string): Promise<AssistantFindingDetail | null> {
  const overview = await readAssistantOverview(ownerId);
  const groupedFinding = overview.groups.find((candidate) => candidate.id === findingId);
  const recommendation = [...overview.recommendations, ...overview.attention, ...overview.blocked, ...overview.uncertain]
    .find((candidate) => candidate.id === findingId);
  const group = groupedFinding ?? (recommendation ? recommendationAsGroup(recommendation) : undefined);
  if (!group) return null;

  const observedAt = overview.summary.lastScan;
  const evidence = group.evidence.map((statement) => ({
    statement,
    source: "assistant_overview",
    sourceId: group.id,
    available: true,
    observedAt,
  }));
  const references = [domainReference(group), {
    kind: "assistant" as const,
    id: group.id,
    label: "Return to assistant findings",
    href: "/assistant",
  }];
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
    freshness: {
      label: overview.summary.freshness,
      observedAt,
      available: Boolean(observedAt),
    },
    uncertainty,
    blockers: group.state === "blocked" ? ["The assistant overview reports this finding as blocked."] : [],
    recommendedAction: group.recommendedAction,
    consequence: "Reviewing this finding does not change files or start provider work. Any later action remains behind the existing review, approval, preflight, and confirmation boundaries.",
    references,
  };
}
