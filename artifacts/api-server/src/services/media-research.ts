import { readUserSetting } from "../lib/archive-db";
import { readMediaExperience, type MediaExperienceItem } from "./media-experience";

export type ResearchCandidate = {
  id: string;
  title: string;
  mediaType: "show";
  releaseDate: string | null;
  year: number | null;
  genres: string[];
  rating: { value: number; scale: 10; voteCount: number | null } | null;
  source: "tvmaze";
  sourceItemId: string;
};

export type ResearchRecommendation = ResearchCandidate & {
  archiveState: "present" | "missing" | "uncertain";
  personalRelevance: "high" | "medium" | "low" | "unknown";
  reasons: string[];
  evidence: Array<{ source: string; field: string; value: string }>;
  confidence: "high" | "medium" | "low";
};

export class ResearchProviderError extends Error {}

function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function number(value: unknown) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

async function searchTvMaze(query: string) {
  const response = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 429) throw new ResearchProviderError("TVMaze rate limit reached. Try again later.");
  if (!response.ok) throw new ResearchProviderError(`TVMaze returned HTTP ${response.status}.`);
  const payload: unknown = await response.json();
  return Array.isArray(payload) ? payload : [];
}

export function mapCandidate(value: unknown): ResearchCandidate | null {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const show = row.show && typeof row.show === "object" ? row.show as Record<string, unknown> : {};
  const id = number(show.id);
  const title = text(show.name);
  if (!id || !title) return null;
  const rating = show.rating && typeof show.rating === "object" ? show.rating as Record<string, unknown> : {};
  const votes = number(show.weight);
  return {
    id: `tvmaze:${id}`, title, mediaType: "show", source: "tvmaze", sourceItemId: String(id),
    releaseDate: text(show.premiered), year: number(show.premiered?.toString().slice(0, 4)),
    genres: Array.isArray(show.genres) ? show.genres.filter((item): item is string => typeof item === "string") : [],
    rating: number(rating.average) === null ? null : { value: number(rating.average)!, scale: 10, voteCount: votes },
  };
}

export function evaluateResearchCandidate(candidate: ResearchCandidate, media: ReturnType<typeof readMediaExperience>): ResearchRecommendation {
  const matchingTitle = media.items.find((item) => normalize(item.title) === normalize(candidate.title));
  const watched = media.items.filter((item) => item.status !== "unwatched");
  const evidence: ResearchRecommendation["evidence"] = [{ source: "tvmaze", field: "title", value: candidate.title }];
  if (candidate.rating) evidence.push({ source: "tvmaze", field: "rating", value: `${candidate.rating.value}/10` });
  const matchingGenres = candidate.genres.filter((genre) => watched.some((item) => item.genres.includes(genre)));
  const archiveState = matchingTitle ? "present" : "missing";
  const personalRelevance = archiveState === "present" ? "low" : matchingGenres.length ? "high" : watched.length ? "low" : "unknown";
  const reasons = archiveState === "present" ? ["already present in synced media evidence"] : ["not present in synced media evidence"];
  if (matchingGenres.length) reasons.push(`shares watched genre evidence: ${matchingGenres.join(", ")}`);
  if (candidate.rating) reasons.push(`TVMaze rating: ${candidate.rating.value}/10`);
  return { ...candidate, archiveState, personalRelevance, reasons, evidence, confidence: matchingTitle || matchingGenres.length ? "high" : "low" };
}

export async function researchCandidate(ownerId: string, query: string) {
  const apiKey = readUserSetting(ownerId, "tvmazeEnabled");
  if (apiKey === false) return { status: "unavailable" as const, reason: "research_source_disabled", items: [] as ResearchRecommendation[] };
  if (!query.trim()) return { status: "unavailable" as const, reason: "query_required", items: [] as ResearchRecommendation[] };
  const results = await searchTvMaze(query);
  const media = readMediaExperience(ownerId);
  const items = results.map(mapCandidate).filter((item): item is ResearchCandidate => Boolean(item)).map((item) => evaluateResearchCandidate(item, media));
  return { status: "available" as const, reason: null, source: "tvmaze" as const, items };
}
