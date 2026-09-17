import assert from "node:assert/strict";
import test from "node:test";
import { buildArchiveOriginResearch } from "../src/services/media-experience";

const item = (episodeNumber: number, releaseDate: string, key: string, provider: "plex" | "jellyfin" = "plex") => ({
  key, provider, title: `Upload ${episodeNumber}`, itemType: "episode", year: null, releaseDate, genres: [], durationMinutes: null,
  status: "unwatched", progressPercent: null, playCount: 0, lastWatchedAt: null, watchedMinutes: 0,
  seriesTitle: "Archive Channel", seasonNumber: 1, episodeNumber, seriesProgress: 0, isNextEpisode: false,
  evidence: [provider === "plex" ? "Plex library metadata" : "Jellyfin user playback metadata"], libraryName: "YouTube Channels", mediaOrigin: "youtube_channel_archive",
});

test("archive ordering collapses provider duplicates and records date provenance", () => {
  const media = { items: [
    item(1, "2025-03-01", "plex:1"), item(1, "2025-03-01", "jellyfin:1", "jellyfin"),
    item(2, "2025-02-01", "plex:2"), item(3, "2025-01-01", "plex:3"),
  ] } as never;
  const [research] = buildArchiveOriginResearch(media);
  const [guidance] = research.orderingGuidance;
  assert.equal(guidance.currentOrder, "newest_to_oldest");
  assert.equal(guidance.confidence, "high");
  assert.equal(guidance.itemCount, 3);
  assert.equal(guidance.provenance.length, 3);
  assert.equal(guidance.incremental.canSafelyAppend, false);
});
