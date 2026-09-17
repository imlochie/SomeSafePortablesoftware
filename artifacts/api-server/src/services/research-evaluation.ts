import { readMediaExperience } from "./media-experience";
import { researchFromViewingHistory, type HistoryResearchCandidate } from "./research-history";
import { ResearchProviderError } from "./media-research";

type Evidence = { source: string; sourceItemId: string; category: "personal" | "relationship" | "archive" | "external_metric" | "release"; field: string; value: string; explanation: string };

export type EvaluatedResearchRecommendation = HistoryResearchCandidate & {
  personalRelevance: "high" | "medium" | "low" | "unknown";
  confidence: "high" | "medium" | "low";
  whyYou: string[];
  whyThis: string[];
  whyNow: string[];
  recommendationEvidence: Evidence[];
  unknowns: string[];
};

async function tvmazeShow(id: string) {
  const response = await fetch(`https://api.tvmaze.com/shows/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (response.status === 429) throw new ResearchProviderError("TVMaze rate limit reached. Try again later.");
  if (!response.ok) throw new ResearchProviderError(`TVMaze returned HTTP ${response.status}.`);
  return response.json() as Promise<Record<string, unknown>>;
}

function number(value: unknown) { const n = Number(value); return Number.isFinite(n) ? n : null; }

export function evaluateResearchRecommendation(candidate: HistoryResearchCandidate, media: ReturnType<typeof readMediaExperience>, details: Record<string, unknown>): EvaluatedResearchRecommendation {
  const sourceItems = media.items.filter((item) => candidate.relationships.some((relationship) => relationship.sourceWatchedItemKey === item.key));
  const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = sourceItems.filter((item) => item.lastWatchedAt && Date.parse(item.lastWatchedAt) >= recentCutoff);
  const repeated = sourceItems.filter((item) => item.playCount >= 2);
  const ratingContainer = details.rating && typeof details.rating === "object" ? details.rating as Record<string, unknown> : {};
  const rating = number(ratingContainer.average);
  const weight = number(details.weight);
  const recommendationEvidence: Evidence[] = candidate.relationships.map((relationship) => ({
    source: relationship.source, sourceItemId: relationship.sourceItemId, category: "relationship", field: relationship.type,
    value: `${relationship.personName} via ${relationship.sourceWatchedItemTitle}`,
    explanation: `Structured ${relationship.type.replace("same_", "")} relationship from the research provider.`,
  }));
  for (const item of sourceItems) recommendationEvidence.push({ source: item.provider, sourceItemId: item.key, category: "personal", field: "watch_history", value: item.title, explanation: "This title is present in the owner's viewing evidence." });
  if (rating !== null) recommendationEvidence.push({ source: "tvmaze", sourceItemId: candidate.candidate.sourceItemId, category: "external_metric", field: "rating", value: `${rating}/10`, explanation: "TVMaze supplied this rating." });
  if (weight !== null) recommendationEvidence.push({ source: "tvmaze", sourceItemId: candidate.candidate.sourceItemId, category: "external_metric", field: "sourceWeight", value: String(weight), explanation: "TVMaze supplied this source weight; it is not treated as a universal popularity score." });
  if (candidate.archiveState === "missing") recommendationEvidence.push({ source: "archive", sourceItemId: candidate.candidate.id, category: "archive", field: "archiveState", value: "missing", explanation: "No confident normalized-title match was found in the owner's synced media evidence." });
  const whyYou = candidate.relationships.map((relationship) => `You watched ${relationship.sourceWatchedItemTitle}; this candidate shares ${relationship.type.replace("same_", "")} ${relationship.personName}.`);
  if (recent.length) whyYou.push(`You watched ${recent.map((item) => item.title).join(", ")} within the last 30 days.`);
  if (repeated.length) whyYou.push(`You rewatched ${repeated.map((item) => item.title).join(", ")}.`);
  const whyThis = candidate.relationships.map((relationship) => `Structured relationship: ${relationship.type.replace("same_", "")} ${relationship.personName}.`);
  if (rating !== null) whyThis.push(`TVMaze rating: ${rating}/10.`);
  const whyNow = recent.length ? ["Related viewing occurred within the last 30 days."] : [];
  const personalRelevance = recent.length || repeated.length || candidate.relationships.length > 1 ? "high" : candidate.relationships.length ? "medium" : "unknown";
  const confidence = rating !== null && candidate.archiveState === "missing" ? "high" : candidate.archiveState === "uncertain" || rating === null ? "low" : "medium";
  const unknowns = [
    ...(candidate.archiveState === "uncertain" ? ["Archive identity is uncertain."] : []),
    ...(rating === null ? ["No external rating is available from the current source."] : []),
    "No watchlist evidence is available.",
    "No franchise relationship is available from the current source.",
  ];
  return { ...candidate, personalRelevance, confidence, whyYou, whyThis, whyNow, recommendationEvidence, unknowns };
}

export async function evaluateViewingResearch(ownerId: string) {
  const generated = await researchFromViewingHistory(ownerId);
  const media = readMediaExperience(ownerId);
  const evaluated: EvaluatedResearchRecommendation[] = [];
  for (const candidate of generated.items) {
    const details = await tvmazeShow(candidate.candidate.sourceItemId);
    evaluated.push(evaluateResearchRecommendation(candidate, media, details));
  }
  return { status: generated.status, source: generated.source, items: evaluated, bounds: generated.bounds, identityUncertain: generated.identityUncertain };
}
