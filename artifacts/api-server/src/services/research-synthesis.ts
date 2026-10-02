import { evaluateViewingResearch, type EvaluatedResearchRecommendation } from "./research-evaluation";
import { ResearchProviderError } from "./media-research";

type SourceEvidence = {
  source: string; sourceItemId: string; category: "metadata" | "rating" | "review" | "popularity" | "release" | "audience" | "critic" | "archive" | "personal" | "relationship";
  field: string; value: string; scale?: string; observedAt: string; provenance: string;
};

export type ResearchSynthesis = EvaluatedResearchRecommendation & {
  whatSupportsIt: string[];
  whatConflicts: string[];
  whatIsUnknown: string[];
  sourceEvidence: SourceEvidence[];
};

async function tvmazeDetails(id: string) {
  const response = await fetch(`https://api.tvmaze.com/shows/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (response.status === 429) throw new ResearchProviderError("TVMaze rate limit reached. Try again later.");
  if (!response.ok) throw new ResearchProviderError(`TVMaze returned HTTP ${response.status}.`);
  return response.json() as Promise<Record<string, unknown>>;
}

type ImdbEvidence = { titleId: string; rating: number | null; voteCount: number | null; popularity: number | null; releaseDate: string | null };

async function imdbDetails(imdbId: string): Promise<ImdbEvidence> {
  const template = process.env.IMDB_API_URL_TEMPLATE?.trim();
  const token = process.env.IMDB_API_TOKEN?.trim();
  if (!template || !token) throw new ResearchProviderError("IMDb access is not configured.");
  const url = template.replace("{imdbId}", encodeURIComponent(imdbId));
  const response = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (response.status === 429) throw new ResearchProviderError("IMDb rate limit reached. Try again later.");
  if (!response.ok) throw new ResearchProviderError(`IMDb returned HTTP ${response.status}.`);
  const result = await response.json() as Record<string, unknown>;
  return {
    titleId: String(result.titleId ?? result.id ?? imdbId),
    rating: number(result.imdbRating ?? result.rating),
    voteCount: number(result.voteCount ?? result.ratingCount),
    popularity: number(result.popularity ?? result.meter),
    releaseDate: typeof result.releaseDate === "string" ? result.releaseDate : null,
  };
}

function number(value: unknown) { const n = Number(String(value).replace(/,/g, "")); return Number.isFinite(n) ? n : null; }
function now() { return new Date().toISOString(); }

export function reconcileAudienceRatings(first: number | null, second: number | null) {
  if (first === null || second === null) return { supports: [], conflicts: [], unknown: ["Comparable audience rating is unavailable from one source."] };
  if (Math.abs(first - second) >= 1) return { supports: [], conflicts: [`Audience ratings differ: ${first}/10 versus ${second}/10.`], unknown: [] };
  return { supports: ["Independent audience ratings are broadly aligned."], conflicts: [], unknown: [] };
}

export async function synthesizeViewingResearch(ownerId: string) {
  const evaluated = await evaluateViewingResearch(ownerId);
  const imdbConfigured = Boolean(process.env.IMDB_API_URL_TEMPLATE?.trim() && process.env.IMDB_API_TOKEN?.trim());
  const items: ResearchSynthesis[] = [];
  for (const item of evaluated.items) {
    const sourceEvidence: SourceEvidence[] = item.recommendationEvidence.map((evidence) => ({
      source: evidence.source, sourceItemId: evidence.sourceItemId, category: evidence.category === "external_metric" ? "rating" : evidence.category === "relationship" ? "metadata" : evidence.category,
      field: evidence.field, value: evidence.value, observedAt: now(), provenance: evidence.explanation,
    }));
    const supports = [...item.whyYou, ...item.whyThis];
    const conflicts: string[] = [];
    const unknowns = [...item.unknowns];
    let tvmazeRating: number | null = null;
    let omdbRating: number | null = null;
    const details = await tvmazeDetails(item.candidate.sourceItemId);
    const externals = details.externals && typeof details.externals === "object" ? details.externals as Record<string, unknown> : {};
    const tvmazeRatingValue = details.rating && typeof details.rating === "object" ? (details.rating as Record<string, unknown>).average : null;
    tvmazeRating = number(tvmazeRatingValue);
    if (tvmazeRating !== null) sourceEvidence.push({ source: "tvmaze", sourceItemId: item.candidate.sourceItemId, category: "audience", field: "rating", value: String(tvmazeRating), scale: "10", observedAt: now(), provenance: "TVMaze audience rating." });
    else unknowns.push("TVMaze audience rating unavailable.");
    if (imdbConfigured && typeof externals.imdb === "string") {
      const imdb = await imdbDetails(externals.imdb);
      omdbRating = imdb.rating;
      if (imdb.rating !== null) sourceEvidence.push({ source: "imdb", sourceItemId: imdb.titleId, category: "audience", field: "rating", value: String(imdb.rating), scale: "10", observedAt: now(), provenance: "IMDb official API audience rating." });
      if (imdb.voteCount !== null) sourceEvidence.push({ source: "imdb", sourceItemId: imdb.titleId, category: "popularity", field: "voteCount", value: String(imdb.voteCount), observedAt: now(), provenance: "IMDb official API vote count." });
      if (imdb.popularity !== null) sourceEvidence.push({ source: "imdb", sourceItemId: imdb.titleId, category: "popularity", field: "popularity", value: String(imdb.popularity), observedAt: now(), provenance: "IMDb official API popularity metric." });
      if (imdb.releaseDate !== null) sourceEvidence.push({ source: "imdb", sourceItemId: imdb.titleId, category: "release", field: "releaseDate", value: imdb.releaseDate, observedAt: now(), provenance: "IMDb official API release metadata." });
    } else {
      unknowns.push(!imdbConfigured ? "IMDb access unavailable: not_configured." : "IMDb evidence unavailable because no IMDb identity is available.");
    }
    const ratingReconciliation = reconcileAudienceRatings(tvmazeRating, omdbRating);
    supports.push(...ratingReconciliation.supports);
    conflicts.push(...ratingReconciliation.conflicts);
    if (tvmazeRating !== null && omdbRating !== null) unknowns.push(...ratingReconciliation.unknown);
    const uniqueUnknowns = [...new Set(unknowns)];
    items.push({ ...item, whatSupportsIt: [...new Set(supports)], whatConflicts: conflicts, whatIsUnknown: uniqueUnknowns, sourceEvidence });
  }
  return { status: evaluated.status, source: "tvmaze+imdb" as const, items, bounds: evaluated.bounds, identityUncertain: evaluated.identityUncertain };
}
