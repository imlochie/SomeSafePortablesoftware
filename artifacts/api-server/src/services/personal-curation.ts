import { readMediaExperience } from "./media-experience";
import { synthesizeViewingResearch, type ResearchSynthesis } from "./research-synthesis";

export type CurationPriority = "high" | "medium" | "low" | "unknown";
export type CurationView = "watch" | "archive";
export type PersonalCurationItem = {
  candidate: ResearchSynthesis["candidate"];
  priorityType: CurationView;
  priority: CurationPriority;
  rank: number;
  reasons: string[];
  supportingEvidence: ResearchSynthesis["recommendationEvidence"];
  conflicts: string[];
  unknowns: string[];
  confidence: ResearchSynthesis["confidence"];
  archiveState: ResearchSynthesis["archiveState"];
  approvalState: "not_created";
};

function priorityRank(value: CurationPriority) { return ({ high: 0, medium: 1, low: 2, unknown: 3 }[value]); }
function recent(value: string | null) { return Boolean(value && Date.parse(value) >= Date.now() - 30 * 24 * 60 * 60 * 1000); }

function derive(item: ResearchSynthesis, media: ReturnType<typeof readMediaExperience>, view: CurationView) {
  const sourceKeys = new Set(item.relationships.map((relationship) => relationship.sourceWatchedItemKey));
  const watched = media.items.filter((candidate) => sourceKeys.has(candidate.key));
  const active = watched.some((candidate) => candidate.status === "in_progress");
  const recentViewing = watched.some((candidate) => recent(candidate.lastWatchedAt));
  const repeated = watched.some((candidate) => candidate.playCount >= 2);
  const missing = item.archiveState === "missing";
  if (view === "watch") {
    const priority: CurationPriority = active || recentViewing ? "high" : watched.length ? "medium" : "unknown";
    const reasons = [
      ...(active ? ["related media is currently in progress"] : []),
      ...(recentViewing ? ["related media was watched recently"] : []),
      ...(item.relationships.length > 1 ? ["multiple structured relationships support this candidate"] : []),
      ...(!active && !recentViewing && watched.length ? ["related viewing evidence exists, but current momentum is limited"] : []),
    ];
    return { priority, reasons: reasons.length ? reasons : ["No current viewing-momentum evidence is available."] };
  }
  const priority: CurationPriority = repeated || (item.relationships.length > 1 && missing) ? "high" : missing && watched.length ? "medium" : missing ? "low" : "unknown";
  const reasons = [
    ...(repeated ? ["related media has been watched repeatedly"] : []),
    ...(item.relationships.length > 1 ? ["multiple independent relationships connect this to your viewing history"] : []),
    ...(missing ? ["candidate is not confidently present in the archive"] : ["archive identity is not a confirmed gap"]),
  ];
  return { priority, reasons };
}

export function rankCuration(items: ResearchSynthesis[], media: ReturnType<typeof readMediaExperience>, view: CurationView): PersonalCurationItem[] {
  return items.map((item) => {
    const derived = derive(item, media, view);
    return {
      candidate: item.candidate, priorityType: view, priority: derived.priority, rank: 0, reasons: derived.reasons,
      supportingEvidence: item.recommendationEvidence, conflicts: item.whatConflicts, unknowns: item.whatIsUnknown,
      confidence: item.confidence, archiveState: item.archiveState, approvalState: "not_created" as const,
    };
  }).sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.candidate.title.localeCompare(right.candidate.title))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

export async function readPersonalCuration(ownerId: string) {
  const synthesis = await synthesizeViewingResearch(ownerId);
  const media = readMediaExperience(ownerId);
  return {
    status: synthesis.status,
    source: synthesis.source,
    watch: rankCuration(synthesis.items, media, "watch"),
    archive: rankCuration(synthesis.items, media, "archive"),
    bounds: synthesis.bounds,
    identityUncertain: synthesis.identityUncertain,
  };
}
