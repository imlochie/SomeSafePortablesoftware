import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  calculateConfidence,
  determineMediaNeedState,
  recommendAcquisition,
  type MediaNeed,
  type SourceOption,
  type TechnicalQuality,
} from "../src/services/acquisition-engine";

const lowQuality: TechnicalQuality = {
  height: 720,
  hdr: false,
  videoCodec: "h264",
  bitrate: 2_000_000,
  audioCodec: "aac",
  audioChannels: 2,
  container: "mkv",
};
const highQuality: TechnicalQuality = {
  height: 2160,
  hdr: true,
  videoCodec: "hevc",
  bitrate: 15_000_000,
  audioCodec: "eac3",
  audioChannels: 6,
  container: "mkv",
};

function need(overrides: Partial<MediaNeed> = {}): MediaNeed {
  return {
    identity: {
      key: "movie:example:2024",
      title: "Example",
      mediaType: "movie",
      year: 2024,
      show: null,
      season: null,
      episode: null,
      confidence: 1,
    },
    scope: "movie",
    archiveState: "missing",
    presentCount: 0,
    expectedCount: 1,
    observedCount: 0,
    archiveQuality: null,
    archiveSizeBytes: 0,
    preferredQuality: null,
    identityConfidence: 1,
    ...overrides,
  };
}

function source(overrides: Partial<SourceOption> = {}): SourceOption {
  return {
    id: "source-a",
    provider: "normalized-provider",
    title: "Example 2024",
    mediaType: "movie",
    scope: "movie",
    season: null,
    episode: null,
    quality: highQuality,
    estimatedSizeBytes: 10_000_000,
    availability: {
      state: "available",
      provider: "normalized-provider",
      discoveredTitle: "Example 2024",
      discoveredId: "candidate-1",
      sourceConfidence: 0.9,
      checkedAt: "2026-09-10T00:00:00.000Z",
    },
    confidence: 0.9,
    ...overrides,
  };
}

const ampleStorage = { freeBytes: 100_000_000, status: "ready" as const };

describe("acquisition intelligence decision engine", () => {
  test("fully present media is not recommended without a quality improvement", () => {
    const result = recommendAcquisition(need({ archiveState: "fully_present", presentCount: 1, observedCount: 1, archiveQuality: highQuality }), [], ampleStorage);
    assert.equal(result.status, "not_recommended");
    assert.ok(result.blockingReasons.includes("already_present"));
  });

  test("missing media with an available source is recommended", () => {
    const result = recommendAcquisition(need(), [source()], ampleStorage);
    assert.equal(result.status, "recommended");
    assert.equal(result.priority, "high");
    assert.equal(result.expectedStorageImpact.status, "sufficient");
    assert.equal(result.blockingReasons.length, 0);
  });

  test("partially present seasons remain actionable", () => {
    const seasonNeed = need({
      scope: "season",
      archiveState: "partially_present",
      presentCount: 2,
      expectedCount: 5,
      observedCount: 5,
      identity: { ...need().identity, key: "tv-season:example:1", title: "Example", mediaType: "tv", season: 1 },
    });
    const result = recommendAcquisition(seasonNeed, [source({ id: "season-source", mediaType: "tv", scope: "season", title: "Example Season 1" })], ampleStorage);
    assert.equal(result.status, "recommended");
    assert.equal(result.priority, "normal");
  });

  test("a higher-quality replacement makes an existing item lower quality", () => {
    assert.equal(determineMediaNeedState({
      identityConfidence: 1,
      presentCount: 1,
      observedCount: 1,
      archiveQuality: lowQuality,
      preferredQuality: highQuality,
    }), "present_lower_quality");
    const result = recommendAcquisition(need({ archiveState: "present_lower_quality", presentCount: 1, observedCount: 1, archiveQuality: lowQuality }), [source()], ampleStorage);
    assert.equal(result.status, "recommended");
  });

  test("unavailable and unknown availability are explicit blockers", () => {
    const unavailable = recommendAcquisition(need(), [source({ availability: { ...source().availability, state: "unavailable" } })], ampleStorage);
    assert.ok(unavailable.blockingReasons.includes("source_unavailable"));
    const unknown = recommendAcquisition(need(), [source({ availability: { ...source().availability, state: "unknown" } })], ampleStorage);
    assert.ok(unknown.blockingReasons.includes("availability_unknown"));
    assert.equal(unknown.status, "not_recommended");
  });

  test("insufficient storage is not hidden by source confidence", () => {
    const result = recommendAcquisition(need(), [source({ estimatedSizeBytes: 101 })], { freeBytes: 100, status: "critical" });
    assert.equal(result.status, "not_recommended");
    assert.ok(result.blockingReasons.includes("insufficient_storage"));
    assert.equal(result.expectedStorageImpact.status, "insufficient");
  });

  test("conflicting equal-confidence candidates require review", () => {
    const result = recommendAcquisition(need(), [
      source({ id: "1080", quality: { ...highQuality, height: 1080 } }),
      source({ id: "2160", quality: highQuality }),
    ], ampleStorage);
    assert.equal(result.status, "not_recommended");
    assert.ok(result.blockingReasons.includes("conflicting_candidates"));
  });

  test("identity, source, availability, quality, and storage confidence are deterministic", () => {
    assert.equal(calculateConfidence({ identityConfidence: 1, sourceConfidence: 1, availabilityConfidence: 1, qualityConfidence: 1, storageConfidence: 1 }), 1);
    assert.equal(calculateConfidence({ identityConfidence: 0.5, sourceConfidence: 0.5, availabilityConfidence: 0.5, qualityConfidence: 0.5, storageConfidence: 0.5 }), 0.5);
    assert.equal(calculateConfidence({ identityConfidence: 0, sourceConfidence: 0, availabilityConfidence: 0, qualityConfidence: 0, storageConfidence: 0 }), 0);
  });
});
