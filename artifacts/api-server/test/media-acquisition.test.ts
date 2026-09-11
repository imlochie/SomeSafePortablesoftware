import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  SONARR_URL: process.env.SONARR_URL,
  SONARR_API_KEY: process.env.SONARR_API_KEY,
};

let mediaAcquisition: typeof import("../src/services/media-acquisition");
let review: typeof import("../src/services/review-queue");
let archiveDb: typeof import("../src/lib/archive-db").archiveDb;

before(async () => {
  process.env.SONARR_URL = "http://media-acquisition.test";
  process.env.SONARR_API_KEY = "test-sonarr-key";
  mediaAcquisition = await import("../src/services/media-acquisition");
  review = await import("../src/services/review-queue");
  ({ archiveDb } = await import("../src/lib/archive-db"));
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    else process.env[key as keyof NodeJS.ProcessEnv] = value;
  }
});

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input, init = {}) =>
    handler(new URL(String(input)), init)) as typeof fetch;
}

describe("media acquisition orchestration", { concurrency: false }, () => {
  test("looks up media and discovers missing items through the selected registry provider", async () => {
    mockFetch((url) => {
      if (url.pathname.endsWith("/system/status")) return jsonResponse({ version: "4.0.0" });
      if (url.pathname.endsWith("/series/lookup")) {
        return jsonResponse([{
          id: 42,
          title: "Example Series",
          year: 2024,
          tvdbId: 9001,
        }]);
      }
      if (url.pathname.endsWith("/wanted/missing")) {
        return jsonResponse({
          records: [{
            id: 901,
            series: { title: "Example Series", year: 2024 },
            seasonNumber: 2,
            episodeNumber: 3,
          }],
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const ownerId = "media-acquisition-owner";
    const lookup = await mediaAcquisition.lookupMedia({
      query: "Example Series",
      mediaType: "series",
      providerId: "sonarr",
    }, ownerId);
    assert.equal(lookup.providerId, "sonarr");
    assert.deepEqual(lookup.records[0], {
      externalId: "42",
      title: "Example Series",
      mediaType: "series",
      year: 2024,
      source: "sonarr",
      metadata: {
        tvdbId: 9001,
        tmdbId: null,
        monitored: undefined,
        overview: undefined,
      },
    });

    const missing = await mediaAcquisition.discoverMissingMedia({
      query: "Example",
      providerId: "sonarr",
    }, ownerId);
    assert.equal(missing.providerId, "sonarr");
    assert.deepEqual(missing.items, [{
      externalId: "901",
      title: "Example Series",
      mediaType: "episode",
      year: 2024,
      detail: "Season 2, episode 3 is missing.",
    }]);
  });

  test("rejects unapproved and cross-owner requests, then starts approved work for the active owner", async () => {
    mockFetch((url) => {
      if (url.pathname.endsWith("/system/status")) return jsonResponse({ version: "4.0.0" });
      if (url.pathname.endsWith("/command")) return jsonResponse({ id: 777, status: "started" });
      throw new Error(`Unexpected URL ${url}`);
    });

    const ownerId = "media-acquisition-request-owner";
    const recommendationId = 999999;
    const item = review.ensureReviewItem(ownerId, {
      kind: "acquisition_recommendation",
      subjectKey: "approved-acquisition-request",
      title: "Acquire Example Series",
      payload: {
        recommendationId,
      },
    });
    await assert.rejects(
      mediaAcquisition.requestMediaAcquisition({ reviewItemId: item.id, confirmed: true }, ownerId),
      /explicitly approved/,
    );
    review.approveReviewItem(item.id, ownerId);
    await assert.rejects(
      mediaAcquisition.requestMediaAcquisition({ reviewItemId: item.id, confirmed: true }, "other-owner"),
      /not found/i,
    );
    await assert.rejects(
      mediaAcquisition.requestMediaAcquisition({ reviewItemId: item.id, confirmed: false as true }, ownerId),
      /confirmation is required/i,
    );

    archiveDb.prepare(`
      INSERT INTO acquisition_recommendation
        (id, owner_id, recommendation_key, media_type, title, year, external_id,
         target_json, evidence_json, quality_json, destination_json, route_json,
         blockers_json, confidence, priority, status, review_item_id, evidence_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      recommendationId,
      ownerId,
      "approved-acquisition-request",
      "series",
      "Example Series",
      2024,
      "901",
      JSON.stringify({ archiveItemId: 14 }),
      JSON.stringify({ reason: "Missing archive episode" }),
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify({ providerId: "sonarr", operational: true }),
      JSON.stringify([]),
      "medium",
      "high",
      item.id,
      "approved-acquisition-evidence",
    );

    const job = await mediaAcquisition.requestMediaAcquisition(
      { reviewItemId: item.id, confirmed: true },
      ownerId,
    );
    assert.equal(job.ownerId, ownerId);
    assert.equal(job.state, "searching");
    assert.equal(job.providerJobId, "777");
    assert.equal(job.metadata.reviewItemId, item.id);
    assert.deepEqual(job.request.policyDecision, {
      decision: "approved",
      reviewItemId: item.id,
      decidedBy: ownerId,
      decisionAt: review.readReviewItem(item.id, ownerId)?.decisionAt,
    });
  });
});