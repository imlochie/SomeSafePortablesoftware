import assert from "node:assert/strict";
import test from "node:test";

test("evaluation keeps candidate provenance separate from recommendation evidence", async () => {
  const { evaluateResearchRecommendation } = await import("../src/services/research-evaluation");
  const candidate = {
    candidate: { id: "tvmaze:9", title: "Candidate", mediaType: "show" as const, source: "tvmaze" as const, sourceItemId: "9", releaseDate: "2020-01-01", year: 2020, genres: ["Crime"] },
    sourceWatchedItem: { key: "plex:1", title: "Watched A", provider: "plex" },
    relationships: [{ type: "same_creator" as const, strength: "direct" as const, source: "tvmaze" as const, sourceItemId: "9", personId: "3", personName: "Creator", sourceWatchedItemKey: "plex:1", sourceWatchedItemTitle: "Watched A" }],
    archiveState: "missing" as const,
    evidence: [{ source: "tvmaze", field: "relationship", value: "same_creator:Creator" }],
    unknowns: [],
  };
  const media = { items: [{ key: "plex:1", title: "Watched A", provider: "plex", itemType: "show", year: 2020, releaseDate: null, genres: ["Crime"], durationMinutes: 40, status: "completed", progressPercent: 100, playCount: 2, lastWatchedAt: new Date().toISOString(), watchedMinutes: 80, seriesTitle: null, seasonNumber: null, episodeNumber: null, seriesProgress: null, isNextEpisode: false, evidence: ["watch history"] }] } as any;
  const result = evaluateResearchRecommendation(candidate, media, { rating: { average: 8.2 }, weight: 410 });
  assert.equal(result.personalRelevance, "high");
  assert.equal(result.confidence, "high");
  assert.ok(result.relationships[0].sourceWatchedItemTitle === "Watched A");
  assert.ok(result.whyYou.some((reason) => reason.includes("Watched A")));
  assert.ok(result.whyNow.length > 0);
  assert.ok(result.recommendationEvidence.some((item) => item.category === "external_metric" && item.field === "rating"));
  assert.ok(result.unknowns.some((item) => item.includes("watchlist")));
});

test("evaluation does not promote a relationship without personal evidence", async () => {
  const { evaluateResearchRecommendation } = await import("../src/services/research-evaluation");
  const candidate = { candidate: { id: "tvmaze:10", title: "Candidate", mediaType: "show" as const, source: "tvmaze" as const, sourceItemId: "10", releaseDate: null, year: null, genres: [] }, sourceWatchedItem: { key: "plex:missing", title: "Missing", provider: "plex" }, relationships: [{ type: "same_creator" as const, strength: "direct" as const, source: "tvmaze" as const, sourceItemId: "10", personId: "4", personName: "Creator", sourceWatchedItemKey: "plex:missing", sourceWatchedItemTitle: "Missing" }], archiveState: "uncertain" as const, evidence: [], unknowns: [] };
  const result = evaluateResearchRecommendation(candidate, { items: [] } as any, {});
  assert.equal(result.personalRelevance, "medium");
  assert.equal(result.confidence, "low");
  assert.equal(result.whyNow.length, 0);
  assert.ok(result.unknowns.some((item) => item.includes("uncertain")));
});
