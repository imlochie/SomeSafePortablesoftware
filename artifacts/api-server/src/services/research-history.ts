import { readMediaExperience, type MediaExperienceItem } from "./media-experience";
import { ResearchProviderError } from "./media-research";

export type ResearchRelationship = {
  type: "same_cast" | "same_creator";
  strength: "direct";
  source: "tvmaze";
  sourceItemId: string;
  personId: string;
  personName: string;
  sourceWatchedItemKey: string;
  sourceWatchedItemTitle: string;
};

export type HistoryResearchCandidate = {
  candidate: {
    id: string;
    title: string;
    mediaType: "show";
    source: "tvmaze";
    sourceItemId: string;
    releaseDate: string | null;
    year: number | null;
    genres: string[];
  };
  sourceWatchedItem: { key: string; title: string; provider: string };
  relationships: ResearchRelationship[];
  archiveState: "present" | "missing" | "uncertain";
  evidence: Array<{ source: string; field: string; value: string }>;
  unknowns: string[];
};

function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function number(value: unknown) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function record(value: unknown) { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function array(value: unknown) { return Array.isArray(value) ? value.map(record) : []; }

async function tvmazeJson(path: string) {
  const response = await fetch(`https://api.tvmaze.com${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (response.status === 429) throw new ResearchProviderError("TVMaze rate limit reached. Try again later.");
  if (!response.ok) throw new ResearchProviderError(`TVMaze returned HTTP ${response.status}.`);
  return response.json() as Promise<unknown>;
}

function showFrom(value: unknown) {
  const row = record(value);
  const embedded = record(row._embedded);
  const show = record(row.show ?? embedded.show ?? row);
  const id = number(show.id);
  const title = text(show.name);
  if (!id || !title) return null;
  return { id: String(id), title, releaseDate: text(show.premiered), year: number(show.premiered?.toString().slice(0, 4)), genres: array(show.genres).map((item) => text(item)).filter((item): item is string => Boolean(item)) };
}

async function matchSeed(item: MediaExperienceItem) {
  const payload = await tvmazeJson(`/search/shows?q=${encodeURIComponent(item.title)}`);
  const results = Array.isArray(payload) ? payload : [];
  const candidates = results.map(showFrom).filter((value): value is NonNullable<ReturnType<typeof showFrom>> => Boolean(value));
  return candidates.find((candidate) => normalize(candidate.title) === normalize(item.title)
    && (item.year === null || candidate.year === null || candidate.year === item.year)) ?? null;
}

async function relatedCredits(seedId: string) {
  const details = record(await tvmazeJson(`/shows/${encodeURIComponent(seedId)}?embed[]=cast&embed[]=crew`));
  const embedded = record(details._embedded);
  const cast = array(embedded.cast).slice(0, 10).map((entry) => {
    const person = record(entry.person); return { id: text(person.id), name: text(person.name), type: "same_cast" as const };
  }).filter((item): item is { id: string; name: string; type: "same_cast" } => Boolean(item.id && item.name));
  const crew = array(embedded.crew).filter((entry) => ["Creator", "Director", "Executive Producer"].includes(String(record(entry.type).name ?? entry.type))).slice(0, 10).map((entry) => {
    const person = record(entry.person); return { id: text(person.id), name: text(person.name), type: "same_creator" as const };
  }).filter((item): item is { id: string; name: string; type: "same_creator" } => Boolean(item.id && item.name));
  const relations = [...cast, ...crew];
  const related: Array<{ show: NonNullable<ReturnType<typeof showFrom>>; relation: typeof relations[number] }> = [];
  for (const relation of relations) {
    const path = relation.type === "same_cast" ? "castcredits" : "crewcredits";
    const credits = array(await tvmazeJson(`/people/${relation.id}/${path}?embed=show`));
    for (const credit of credits) {
      const show = showFrom(credit);
      if (show && show.id !== seedId) related.push({ show, relation });
    }
  }
  return related;
}

export async function researchFromViewingHistory(ownerId: string) {
  const media = readMediaExperience(ownerId);
  // TVMaze relationship research is meaningful for canonical scripted series only.
  // YouTube/channel archives and personal media are researched from their own
  // viewing cadence instead of being incorrectly forced through TV metadata.
  const watched = media.items.filter((item) => item.status !== "unwatched" && item.mediaOrigin === "canonical_series").slice(0, 20);
  const excludedOrigins = [...new Set(media.items.filter((item) => item.status !== "unwatched" && item.mediaOrigin !== "canonical_series").map((item) => item.mediaOrigin))];
  const aggregated = new Map<string, HistoryResearchCandidate>();
  let identityUncertain = 0;
  for (const watchedItem of watched) {
    const seed = await matchSeed(watchedItem);
    if (!seed) { identityUncertain += 1; continue; }
    for (const related of await relatedCredits(seed.id)) {
      const existing = aggregated.get(related.show.id);
      const relationship: ResearchRelationship = {
        type: related.relation.type, strength: "direct", source: "tvmaze", sourceItemId: related.show.id,
        personId: related.relation.id, personName: related.relation.name,
        sourceWatchedItemKey: watchedItem.key, sourceWatchedItemTitle: watchedItem.title,
      };
      if (existing) {
        if (!existing.relationships.some((item) => item.type === relationship.type && item.personId === relationship.personId && item.sourceWatchedItemKey === watchedItem.key)) existing.relationships.push(relationship);
        existing.evidence.push({ source: "tvmaze", field: "relationship", value: `${relationship.type}:${relationship.personName}` });
        continue;
      }
      const archiveMatches = media.items.filter((item) => normalize(item.title) === normalize(related.show.title));
      const archiveState = archiveMatches.length > 1 ? "uncertain" as const : archiveMatches.length === 1 ? "present" as const : "missing" as const;
      aggregated.set(related.show.id, {
        candidate: { ...related.show, mediaType: "show", source: "tvmaze", sourceItemId: related.show.id, id: `tvmaze:${related.show.id}` },
        sourceWatchedItem: { key: watchedItem.key, title: watchedItem.title, provider: watchedItem.provider },
        relationships: [relationship], archiveState,
        evidence: [{ source: "tvmaze", field: "relationship", value: `${relationship.type}:${relationship.personName}` }],
        unknowns: ["No ranking or broad similarity inference is performed."],
      });
    }
  }
  const items = [...aggregated.values()].filter((item) => item.archiveState !== "present").slice(0, 100);
  return { status: watched.length ? "available" as const : "limited" as const, source: "tvmaze" as const, items, bounds: { maxWatchedSeeds: 20, maxCandidates: 100 }, identityUncertain, excludedOrigins, researchPolicy: "TVMaze relationships are limited to canonical scripted series; archive-native sources use origin-aware viewing research." };
}
