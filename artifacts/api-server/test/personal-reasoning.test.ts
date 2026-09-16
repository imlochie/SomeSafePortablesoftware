import assert from "node:assert/strict";
import test from "node:test";

test("reasoning builds a multi-evidence argument and separates watch/archive conclusions", async () => {
  const { reasonAboutCandidate } = await import("../src/services/personal-reasoning");
  const item = {
    candidate: { id: "tvmaze:1", title: "Candidate", mediaType: "show" as const, source: "tvmaze" as const, sourceItemId: "1", releaseDate: null, year: null, genres: ["Crime"] },
    sourceWatchedItem: { key: "plex:1", title: "Watched", provider: "plex" },
    relationships: [
      { type: "same_creator" as const, strength: "direct" as const, source: "tvmaze" as const, sourceItemId: "1", personId: "1", personName: "Creator", sourceWatchedItemKey: "plex:1", sourceWatchedItemTitle: "Watched" },
      { type: "same_cast" as const, strength: "direct" as const, source: "tvmaze" as const, sourceItemId: "1", personId: "2", personName: "Actor", sourceWatchedItemKey: "plex:1", sourceWatchedItemTitle: "Watched" },
    ],
    archiveState: "missing" as const, evidence: [], unknowns: [], whatConflicts: [], whatIsUnknown: [],
    recommendationEvidence: [{ source: "tvmaze", sourceItemId: "1", category: "external_metric" as const, field: "rating", value: "8.4", explanation: "rating" }],
  } as any;
  const media = { items: [{ key: "plex:1", title: "Watched", provider: "plex", itemType: "show", year: null, releaseDate: null, genres: ["Crime"], durationMinutes: 40, status: "completed", progressPercent: 100, playCount: 2, lastWatchedAt: new Date().toISOString(), watchedMinutes: 80, seriesTitle: null, seasonNumber: null, episodeNumber: null, seriesProgress: null, isNextEpisode: false, evidence: [] }] } as any;
  const result = reasonAboutCandidate(item, media);
  assert.equal(result.archive.conclusion, "strong_archive_candidate");
  assert.equal(result.watch.conclusion, "strong_watch_candidate");
  assert.ok(result.supportingEvidence.length >= 3);
  assert.ok(result.patternEvidence.some((reason) => reason.includes("watched repeatedly")));
  assert.ok(result.context.length > 0);
  assert.ok(result.evidenceReferences.length > 0);
});

test("reasoning preserves unknowns and can recommend further research", async () => {
  const { reasonAboutCandidate } = await import("../src/services/personal-reasoning");
  const item = { candidate: { id: "tvmaze:2", title: "Unknown", mediaType: "show", source: "tvmaze", sourceItemId: "2", releaseDate: null, year: null, genres: [] }, sourceWatchedItem: { key: "plex:missing", title: "Missing source", provider: "plex" }, relationships: [{ type: "same_creator", strength: "direct", source: "tvmaze", sourceItemId: "2", personId: "2", personName: "Creator", sourceWatchedItemKey: "plex:missing", sourceWatchedItemTitle: "Missing source" }], archiveState: "uncertain", recommendationEvidence: [], whatIsUnknown: ["No rating"], whatConflicts: [] } as any;
  const result = reasonAboutCandidate(item, { items: [] } as any);
  assert.equal(result.watch.conclusion, "research_further");
  assert.equal(result.archive.conclusion, "interesting_but_uncertain");
  assert.ok(result.counterEvidence.some((reason) => reason.includes("uncertain")));
  assert.ok(result.unknowns.includes("No rating"));
  const missingPersonal = { ...item, archiveState: "missing" as const };
  const negative = reasonAboutCandidate(missingPersonal, { items: [] } as any);
  assert.equal(negative.archive.conclusion, "not_recommended");
});
