import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  SONARR_URL: process.env.SONARR_URL,
  SONARR_API_KEY: process.env.SONARR_API_KEY,
};

let mediaAcquisition: typeof import("../src/services/media-acquisition");

before(async () => {
  process.env.SONARR_URL = "http://media-acquisition.test";
  process.env.SONARR_API_KEY = "test-sonarr-key";
  mediaAcquisition = await import("../src/services/media-acquisition");
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

  test("persists archive identity and policy context before creating the provider job", async () => {
    mockFetch((url) => {
      if (url.pathname.endsWith("/system/status")) return jsonResponse({ version: "4.0.0" });
      if (url.pathname.endsWith("/command")) return jsonResponse({ id: 777, status: "started" });
      throw new Error(`Unexpected URL ${url}`);
    });

    const archiveIdentity = {
      archiveItemId: 14,
      identityKey: "tv:example series:2:3",
      season: 2,
      episode: 3,
    };
    const policyDecision = {
      decision: "approved",
      reason: "missing archive episode",
      requestedBy: "operator",
    };
    const job = await mediaAcquisition.requestMediaAcquisition({
      mediaType: "episode",
      title: "Example Series",
      externalId: "901",
      providerId: "sonarr",
      archiveIdentity,
      policyDecision,
      metadata: { source: "missing-media" },
    }, "media-acquisition-request-owner");

    assert.equal(job.state, "searching");
    assert.equal(job.providerJobId, "777");
    assert.deepEqual(job.request.archiveIdentity, archiveIdentity);
    assert.deepEqual(job.request.policyDecision, policyDecision);
    assert.deepEqual(job.metadata, {
      source: "missing-media",
      archiveIdentity,
      policyDecision,
    });
  });
});