import assert from "node:assert/strict";
import test from "node:test";

function candidate(id: string, title: string, archiveState: "missing" | "uncertain", sourceKey: string, relationshipCount = 1) {
  return {
    candidate: { id, title, mediaType: "show" as const, source: "tvmaze" as const, sourceItemId: id, releaseDate: null, year: null, genres: [] },
    sourceWatchedItem: { key: sourceKey, title: "Watched", provider: "plex" },
    relationships: Array.from({ length: relationshipCount }, (_, index) => ({ type: "same_creator" as const, strength: "direct" as const, source: "tvmaze" as const, sourceItemId: id, personId: String(index), personName: "Creator", sourceWatchedItemKey: sourceKey, sourceWatchedItemTitle: "Watched" })),
    archiveState, evidence: [], unknowns: [], personalRelevance: "medium" as const, confidence: "medium" as const,
    whyYou: [], whyThis: [], whyNow: [], recommendationEvidence: [], whatSupportsIt: [], whatConflicts: [], whatIsUnknown: [],
  };
}

test("watch and archive priorities diverge", async () => {
  const { rankCuration } = await import("../src/services/personal-curation");
  const media = { items: [
    { key: "recent", title: "Recent", provider: "plex", itemType: "show", year: null, releaseDate: null, genres: [], durationMinutes: 30, status: "in_progress", progressPercent: 30, playCount: 1, lastWatchedAt: new Date().toISOString(), watchedMinutes: 10, seriesTitle: null, seasonNumber: null, episodeNumber: null, seriesProgress: null, isNextEpisode: false, evidence: [] },
    { key: "repeat", title: "Repeat", provider: "plex", itemType: "show", year: null, releaseDate: null, genres: [], durationMinutes: 30, status: "completed", progressPercent: 100, playCount: 3, lastWatchedAt: "2020-01-01T00:00:00.000Z", watchedMinutes: 90, seriesTitle: null, seasonNumber: null, episodeNumber: null, seriesProgress: null, isNextEpisode: false, evidence: [] },
  ] } as any;
  const result = [candidate("a", "Recent candidate", "missing", "recent"), candidate("b", "Repeat candidate", "missing", "repeat")];
  const watch = rankCuration(result, media, "watch");
  const archive = rankCuration(result, media, "archive");
  assert.equal(watch[0].candidate.title, "Recent candidate");
  assert.equal(watch[0].priority, "high");
  assert.equal(archive[0].candidate.title, "Repeat candidate");
  assert.equal(archive[0].priority, "high");
  assert.equal(archive[1].priority, "medium");
});

test("download presence does not outrank repeated viewing", async () => {
  const { rankCuration } = await import("../src/services/personal-curation");
  const media = { items: [{ key: "watched", title: "Repeated", provider: "plex", itemType: "show", year: null, releaseDate: null, genres: [], durationMinutes: 30, status: "completed", progressPercent: 100, playCount: 3, lastWatchedAt: "2020-01-01T00:00:00.000Z", watchedMinutes: 90, seriesTitle: null, seasonNumber: null, episodeNumber: null, seriesProgress: null, isNextEpisode: false, evidence: [] }] } as any;
  const archiveOnly = candidate("a", "Archive only", "missing", "none");
  const repeated = candidate("b", "Repeated", "missing", "watched");
  const result = rankCuration([archiveOnly, repeated], media, "archive");
  assert.equal(result[0].candidate.title, "Repeated");
  assert.equal(result[0].priority, "high");
  assert.equal(result[1].priority, "low");
});
