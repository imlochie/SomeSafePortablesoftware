import assert from "node:assert/strict";
import test from "node:test";

test("research candidate normalization preserves source IDs and metrics", async () => {
  const { mapCandidate } = await import("../src/services/media-research");
  const candidate = mapCandidate({ show: {
    id: 42, name: "Research Show", premiered: "2024-02-03", genres: ["Crime"],
    rating: { average: 8.4 }, weight: 123,
  } });
  assert.deepEqual(candidate, {
    id: "tvmaze:42", title: "Research Show", mediaType: "show", releaseDate: "2024-02-03",
    year: 2024, genres: ["Crime"], rating: { value: 8.4, scale: 10, voteCount: 123 },
    source: "tvmaze", sourceItemId: "42",
  });
});

test("research evaluation preserves archive gap, watch evidence, provenance, and metrics", async () => {
  const { evaluateResearchCandidate } = await import("../src/services/media-research");
  const media = { items: [{
    key: "plex:watched", title: "Watched Crime", provider: "plex", itemType: "show", year: 2020,
    releaseDate: null, genres: ["Crime"], durationMinutes: 45, status: "completed", progressPercent: 100,
    playCount: 1, lastWatchedAt: "2026-09-01T00:00:00.000Z", watchedMinutes: 45,
    seriesTitle: null, seasonNumber: null, episodeNumber: null, seriesProgress: null, isNextEpisode: false,
    evidence: ["Plex view count"],
  }] } as any;
  const result = evaluateResearchCandidate({
    id: "tvmaze:99", title: "Missing Crime", mediaType: "show", releaseDate: "2024-01-01",
    year: 2024, genres: ["Crime"], rating: { value: 8.1, scale: 10, voteCount: 500 },
    source: "tvmaze", sourceItemId: "99",
  }, media);
  assert.equal(result.archiveState, "missing");
  assert.equal(result.personalRelevance, "high");
  assert.ok(result.reasons.some((reason) => reason.includes("watched genre")));
  assert.ok(result.evidence.some((evidence) => evidence.field === "rating" && evidence.value === "8.1/10"));
});

test("research source is explicit when provider is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("rate limited", { status: 429 });
  try {
    const { researchCandidate } = await import("../src/services/media-research");
    await assert.rejects(() => researchCandidate("__local__", "Example"), /rate limit/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
