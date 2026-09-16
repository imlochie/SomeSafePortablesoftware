import { readMediaExperience } from "./media-experience";
import { buildMediaProfile } from "./media-profile";
import { synthesizeViewingResearch, type ResearchSynthesis } from "./research-synthesis";

export type ReasoningConclusion = "strong_watch_candidate" | "watch_candidate" | "strong_archive_candidate" | "archive_candidate" | "interesting_but_uncertain" | "research_further" | "not_recommended" | "already_satisfied" | "archive_redundant";
export type ReasoningConfidence = "high" | "medium" | "low";

export type PersonalMediaReasoning = {
  candidate: ResearchSynthesis["candidate"];
  claim: string;
  supportingEvidence: string[];
  counterEvidence: string[];
  patternEvidence: string[];
  context: string[];
  gaps: string[];
  unknowns: string[];
  watch: { conclusion: ReasoningConclusion; confidence: ReasoningConfidence };
  archive: { conclusion: ReasoningConclusion; confidence: ReasoningConfidence };
  evidenceReferences: Array<{ source: string; sourceItemId: string; field: string; category: string }>;
  perspectives: {
    personal: string[];
    current: string[];
    longTerm: string[];
    archiveValue: string[];
    archiveGap: string[];
    relationship: string[];
    external: string[];
    novelty: string[];
    temporal: string[];
    availability: string[];
    identity: string[];
    counterEvidence: string[];
    unknowns: string[];
  };
};

function recent(value: string | null) { return Boolean(value && Date.parse(value) >= Date.now() - 30 * 24 * 60 * 60 * 1000); }

export function reasonAboutCandidate(item: ResearchSynthesis, media: ReturnType<typeof readMediaExperience>): PersonalMediaReasoning {
  const keys = new Set(item.relationships.map((relationship) => relationship.sourceWatchedItemKey));
  const profile = buildMediaProfile(media);
  const watched = media.items.filter((mediaItem) => keys.has(mediaItem.key));
  const recentItems = watched.filter((mediaItem) => recent(mediaItem.lastWatchedAt));
  const repeatedItems = watched.filter((mediaItem) => mediaItem.playCount >= 2);
  const supportingEvidence: string[] = [];
  const patternEvidence: string[] = [];
  const context: string[] = [];
  const counterEvidence: string[] = [];
  const gaps: string[] = [];
  const unknowns = [...item.whatIsUnknown];
  if (watched.length) supportingEvidence.push(`${watched.length} watched source item${watched.length === 1 ? "" : "s"} support this candidate.`);
  if (recentItems.length) { supportingEvidence.push(`Related viewing was recent: ${recentItems.map((mediaItem) => mediaItem.title).join(", ")}.`); context.push("The related viewing cluster is active within the last 30 days."); }
  if (repeatedItems.length) { supportingEvidence.push(`Related titles were rewatched: ${repeatedItems.map((mediaItem) => mediaItem.title).join(", ")}.`); patternEvidence.push(`${repeatedItems.length} related title${repeatedItems.length === 1 ? " was" : "s were"} watched repeatedly.`); }
  if (item.relationships.length > 1) supportingEvidence.push(`${item.relationships.length} structured relationships converge on this candidate.`);
  if (item.archiveState === "missing") gaps.push("Candidate is missing from the archive.");
  if (item.archiveState === "uncertain") { gaps.push("Potential archive gap could not be confirmed."); unknowns.push("Archive identity is uncertain."); counterEvidence.push("Archive identity is uncertain, so permanent collection value cannot be confirmed."); }
  const relatedGenres = new Set(watched.flatMap((mediaItem) => mediaItem.genres));
  const matchingGenreCount = media.items.filter((mediaItem) => mediaItem.genres.some((genre) => relatedGenres.has(genre))).length;
  if (matchingGenreCount >= 3) patternEvidence.push(`${matchingGenreCount} provider items share structured genre evidence with the watched cluster.`);
  const profileClusters = profile.patterns.genres.filter((cluster) => item.candidate.genres.includes(cluster.label));
  for (const cluster of profileClusters) patternEvidence.push(`Profile cluster ${cluster.label}: ${cluster.watchedCount} watched, ${cluster.rewatchedCount} rewatched, ${cluster.recentWatchedCount} recent.`);
  if (item.sourceWatchedItem && !watched.length) counterEvidence.push("The relationship source could not be matched to current local watch evidence.");
  if (!watched.length) { unknowns.push("No current personal viewing evidence was available for the relationship source."); }
  if (!watched.length && item.recommendationEvidence.some((evidence) => evidence.category === "external_metric")) counterEvidence.push("External reception is available, but meaningful personal viewing evidence is not.");
  if (item.archiveState === "missing") supportingEvidence.push("Archive comparison found no confident local match.");
  const strongPersonal = recentItems.length > 0 || repeatedItems.length > 0 || item.relationships.length > 1;
  const watchConclusion: ReasoningConclusion = strongPersonal ? "strong_watch_candidate" : watched.length ? "watch_candidate" : "research_further";
  const archiveConclusion: ReasoningConclusion = !watched.length && item.archiveState === "missing" ? "not_recommended"
    : repeatedItems.length || (item.relationships.length > 1 && item.archiveState === "missing")
      ? "strong_archive_candidate"
      : item.archiveState === "uncertain" ? "interesting_but_uncertain"
        : watched.length && item.archiveState === "missing" ? "archive_candidate" : "research_further";
  const confidence: ReasoningConfidence = counterEvidence.length || unknowns.length > item.unknowns.length + 1 ? "medium" : supportingEvidence.length >= 3 ? "high" : "medium";
  const evidenceReferences = item.recommendationEvidence.map((evidence) => ({ source: evidence.source, sourceItemId: evidence.sourceItemId, field: evidence.field, category: evidence.category }));
  const perspectives = {
    personal: watched.length ? supportingEvidence.filter((reason) => reason.includes("watched") || reason.includes("Related")) : ["No meaningful personal viewing evidence is available."],
    current: context.length ? context : ["No current viewing-context signal is available."],
    longTerm: repeatedItems.length || patternEvidence.length ? [...patternEvidence] : ["Long-term repeat-viewing evidence is limited."],
    archiveValue: repeatedItems.length ? ["Repeated related viewing supports long-term archive value."] : ["Long-term archive value is not strongly established."],
    archiveGap: gaps.length ? [...gaps] : ["No confirmed archive gap is available."],
    relationship: item.relationships.map((relationship) => `${relationship.type}: ${relationship.personName}`),
    external: item.recommendationEvidence.filter((evidence) => evidence.category === "external_metric").map((evidence) => `${evidence.field}: ${evidence.value}`),
    novelty: ["Novelty is not established by the current structured evidence."],
    temporal: context.length ? [...context] : ["No temporal relevance is established."],
    availability: ["Operational availability is not part of the current research evidence."],
    identity: [item.archiveState === "uncertain" ? "Archive identity is uncertain." : "Candidate identity passed the available research identity checks."],
    counterEvidence: [...new Set(counterEvidence)],
    unknowns: [...new Set(unknowns)],
  };
  return { candidate: item.candidate, claim: archiveConclusion === "strong_archive_candidate" ? "This candidate may deserve a permanent place in the archive." : watchConclusion === "strong_watch_candidate" ? "This candidate is especially relevant to watch now." : "This candidate requires further evidence before a strong personal conclusion.", supportingEvidence: [...new Set(supportingEvidence)], counterEvidence: [...new Set(counterEvidence)], patternEvidence: [...new Set(patternEvidence)], context: [...new Set(context)], gaps, unknowns: [...new Set(unknowns)], watch: { conclusion: watchConclusion, confidence }, archive: { conclusion: archiveConclusion, confidence }, evidenceReferences, perspectives };
}

export async function readPersonalReasoning(ownerId: string) {
  const synthesis = await synthesizeViewingResearch(ownerId);
  const media = readMediaExperience(ownerId);
  return { status: synthesis.status, source: synthesis.source, items: synthesis.items.map((item) => reasonAboutCandidate(item, media)), bounds: synthesis.bounds, identityUncertain: synthesis.identityUncertain };
}
