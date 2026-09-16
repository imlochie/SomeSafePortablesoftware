import assert from "node:assert/strict";
import test from "node:test";

test("media profile distinguishes observed viewing from derived clusters", async () => {
  const { buildMediaProfile, buildArchiveGraph } = await import("../src/services/media-profile");
  const media = { items: [
    { key: "a", title: "A", provider: "plex", itemType: "movie", year: 2005, releaseDate: null, genres: ["Crime"], durationMinutes: 100, status: "completed", progressPercent: 100, playCount: 3, lastWatchedAt: new Date().toISOString(), watchedMinutes: 300, seriesTitle: null, seasonNumber: null, episodeNumber: null, seriesProgress: null, isNextEpisode: false, evidence: [] },
    { key: "b", title: "B", provider: "plex", itemType: "movie", year: 2006, releaseDate: null, genres: ["Crime"], durationMinutes: 90, status: "in_progress", progressPercent: 40, playCount: 1, lastWatchedAt: new Date().toISOString(), watchedMinutes: 36, seriesTitle: null, seasonNumber: null, episodeNumber: null, seriesProgress: null, isNextEpisode: false, evidence: [] },
  ], inProgress: [], currentViewingMomentum: { activeSeriesCount: 0 }, summary: { watchedHours: 5.6 } } as any;
  const profile = buildMediaProfile(media);
  assert.equal(profile.viewing.watchedItems, 2);
  assert.equal(profile.viewing.rewatchedCount, 1);
  assert.equal(profile.patterns.genres[0].watchedCount, 2);
  assert.equal(profile.patterns.genres[0].rewatchedCount, 1);
  assert.equal(buildArchiveGraph(profile).clusters.length, 1);
});
