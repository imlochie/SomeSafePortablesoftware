import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { IntegrationConfiguration } from "../src/integrations/config";

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  SONARR_URL: process.env.SONARR_URL,
  SONARR_API_KEY: process.env.SONARR_API_KEY,
  SONARR_WEBHOOK_SECRET: process.env.SONARR_WEBHOOK_SECRET,
  QBITTORRENT_URL: process.env.QBITTORRENT_URL,
  QBITTORRENT_USERNAME: process.env.QBITTORRENT_USERNAME,
  QBITTORRENT_PASSWORD: process.env.QBITTORRENT_PASSWORD,
};

let acquisition: typeof import("../src/services/acquisition-jobs");
let createSonarrAdapter: typeof import("../src/integrations").createSonarrAdapter;

before(async () => {
  process.env.SONARR_URL = "http://acquisition.test";
  process.env.SONARR_API_KEY = "test-sonarr-key";
  process.env.SONARR_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.QBITTORRENT_URL = "http://acquisition.test";
  process.env.QBITTORRENT_USERNAME = "test-user";
  process.env.QBITTORRENT_PASSWORD = "test-password";
  ({ createSonarrAdapter } = await import("../src/integrations"));
  acquisition = await import("../src/services/acquisition-jobs");
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    else process.env[key as keyof NodeJS.ProcessEnv] = value;
  }
});

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function textResponse(value: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(value, { status, headers });
}

function mockFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input, init = {}) =>
    handler(new URL(String(input)), init)) as typeof fetch;
}

function signWebhook(body: string, secret = "test-webhook-secret") {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("canonical acquisition jobs", { concurrency: false }, () => {
  test("persists a provider-backed request through the complete lifecycle without local file work", async () => {
    mockFetch((url) => {
      if (url.pathname.endsWith("/system/status")) return jsonResponse({ version: "4.0.0" });
      if (url.pathname.endsWith("/command")) return jsonResponse({ id: 700, status: "started" });
      throw new Error(`Unexpected URL ${url}`);
    });

    const ownerId = "acquisition-owner-complete";
    const job = await acquisition.createAcquisitionJob({
      mediaType: "series",
      title: "Example Series",
      externalId: "42",
      providerId: "sonarr",
      metadata: { requestReason: "operator" },
      start: true,
    }, ownerId);

    assert.equal(job?.state, "searching");
    assert.equal(job?.providerJobId, "700");
    assert.equal(job?.downloadJobId, null);
    assert.equal(job?.events[0]?.toState, "planned");
    assert.equal(job?.events.at(-1)?.toState, "searching");

    let current = acquisition.progressAcquisitionJob(job!.id, ownerId, {
      state: "source_selected",
      progress: 18,
      metadata: { source: "indexer-a" },
    });
    current = acquisition.progressAcquisitionJob(job!.id, ownerId, {
      state: "downloading",
      progress: 45,
    });
    current = acquisition.progressAcquisitionJob(job!.id, ownerId, {
      state: "processing",
      progress: 70,
    });
    current = acquisition.progressAcquisitionJob(job!.id, ownerId, {
      state: "verifying",
      progress: 82,
    });
    current = acquisition.progressAcquisitionJob(job!.id, ownerId, {
      state: "importing",
      progress: 94,
    });
    current = acquisition.progressAcquisitionJob(job!.id, ownerId, {
      state: "complete",
      progress: 100,
    });

    assert.equal(current?.state, "complete");
    assert.equal(current?.progress, 100);
    assert.ok(current?.searchingAt);
    assert.ok(current?.sourceSelectedAt);
    assert.ok(current?.downloadingAt);
    assert.ok(current?.processingAt);
    assert.ok(current?.verifyingAt);
    assert.ok(current?.importingAt);
    assert.ok(current?.completedAt);
    assert.deepEqual(current?.metadata, {
      requestReason: "operator",
      source: "indexer-a",
    });
    assert.equal(current?.events.length, 9);
  });

  test("records provider failures durably and retries with bounded attempts", async () => {
    mockFetch(() => jsonResponse({ error: "unauthorized" }, 401));
    const ownerId = "acquisition-owner-failure";
    const failed = await acquisition.createAcquisitionJob({
      mediaType: "movie",
      title: "Unavailable Movie",
      externalId: "84",
      providerId: "sonarr",
      start: true,
    }, ownerId);

    assert.equal(failed?.state, "failed");
    assert.equal(failed?.errorCode, "PROVIDER_UNAVAILABLE");
    assert.match(failed?.errorMessage ?? "", /no operational adapter/i);
    assert.equal(failed?.events.at(-1)?.toState, "failed");

    const retried = await acquisition.retryAcquisitionJob(failed!.id, ownerId);
    assert.equal(retried?.state, "failed");
    assert.equal(retried?.retryCount, 1);
    assert.equal(retried?.events.at(-1)?.toState, "failed");
    assert.doesNotMatch(retried?.errorMessage ?? "", /test-sonarr-key|test-password/);

    assert.throws(
      () => acquisition.progressAcquisitionJob(failed!.id, ownerId, { state: "complete" }),
      /Cannot move an acquisition job from failed to complete/,
    );
  });

  test("tracks qBittorrent downloads and maps provider refreshes into processing", async () => {
    mockFetch((url) => {
      if (url.pathname.endsWith("/auth/login")) {
        return textResponse("Ok.", 200, { "set-cookie": "SID=acquisition-session; Path=/" });
      }
      if (url.pathname.endsWith("/app/version")) return textResponse("4.6.0");
      if (url.pathname.endsWith("/torrents/add")) return textResponse("Ok.");
      if (url.pathname.endsWith("/torrents/info")) {
        return jsonResponse([{
          hash: "abc123",
          name: "Example Movie",
          state: "uploading",
          progress: 1,
        }]);
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const job = await acquisition.createAcquisitionJob({
      mediaType: "movie",
      title: "Example Movie",
      sourceId: "magnet:?xt=urn:btih:abc123",
      providerId: "qbittorrent",
      metadata: { hash: "abc123" },
      start: true,
    }, "acquisition-owner-qbit");

    assert.equal(job?.state, "downloading");
    assert.equal(job?.providerJobId, "abc123");

    const refreshed = await acquisition.refreshAcquisitionJob(job!.id, "acquisition-owner-qbit");
    assert.equal(refreshed?.state, "processing");
    assert.equal(refreshed?.progress, 100);
    assert.equal(refreshed?.metadata.providerStatus, "uploading");
    assert.equal(refreshed?.metadata.providerStatusState, "completed");
  });

  test("automatically refreshes active jobs and keeps stale or unavailable providers explicit", async () => {
    let providerMode: "active" | "stale" | "unavailable" = "active";
    mockFetch((url) => {
      if (providerMode === "unavailable") throw new Error("provider is offline");
      if (url.pathname.endsWith("/system/status")) return jsonResponse({ version: "4.0.0" });
      if (url.pathname.endsWith("/command")) return jsonResponse({ id: 701, status: "started" });
      if (url.pathname.endsWith("/queue")) {
        return jsonResponse(providerMode === "stale"
          ? { records: [] }
          : {
              records: [{
                id: 701,
                status: "downloading",
                size: 100,
                sizeleft: 75,
                title: "Polling Movie",
              }],
            });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const ownerId = "acquisition-owner-polling";
    const job = await acquisition.createAcquisitionJob({
      mediaType: "series",
      title: "Polling Movie",
      externalId: "701",
      providerId: "sonarr",
      start: true,
    }, ownerId);
    assert.equal(job?.state, "searching");

    let summary = await acquisition.refreshActiveAcquisitionJobs({
      maxJobs: 10,
      maxJobsPerOwner: 10,
      concurrency: 1,
    });
    let refreshed = acquisition.readAcquisitionJob(job!.id, ownerId);
    assert.equal(summary.active, 1);
    assert.equal(refreshed?.metadata.providerStatusState, "active");
    assert.equal(refreshed?.progress, 25);
    assert.equal(refreshed?.state, "downloading");
    assert.equal(refreshed?.downloadJobId, null);

    providerMode = "stale";
    summary = await acquisition.refreshActiveAcquisitionJobs({ concurrency: 1 });
    refreshed = acquisition.readAcquisitionJob(job!.id, ownerId);
    assert.equal(summary.stale, 1);
    assert.equal(refreshed?.metadata.providerStatusState, "stale");
    assert.equal(refreshed?.state, "downloading");
    assert.equal(refreshed?.downloadJobId, null);

    providerMode = "unavailable";
    summary = await acquisition.refreshActiveAcquisitionJobs({ concurrency: 1 });
    refreshed = acquisition.readAcquisitionJob(job!.id, ownerId);
    assert.equal(summary.unavailable, 1);
    assert.equal(refreshed?.metadata.providerStatusState, "unavailable");
    assert.equal(refreshed?.state, "downloading");
    assert.equal(refreshed?.errorCode, null);
    assert.equal(refreshed?.downloadJobId, null);
  });

  test("cancellation is local tracking only and retry returns a planned job", async () => {
    const ownerId = "acquisition-owner-cancel";
    const planned = await acquisition.createAcquisitionJob({
      mediaType: "movie",
      title: "Planned Movie",
      start: false,
    }, ownerId);
    const cancelled = acquisition.cancelAcquisitionJob(planned!.id, ownerId);
    assert.equal(cancelled?.state, "cancelled");
    assert.match(cancelled?.events.at(-1)?.detail ?? "", /No local filesystem changes/);

    const retried = await acquisition.retryAcquisitionJob(planned!.id, ownerId);
    assert.equal(retried?.state, "planned");
    assert.equal(retried?.retryCount, 1);
    assert.equal(retried?.providerId, null);
  });

  test("authenticated Sonarr webhooks normalize lifecycle events and reject tampering", () => {
    const config: IntegrationConfiguration = {
      endpoint: "http://acquisition.test",
      credentialsConfigured: true,
      apiKey: "test-sonarr-key",
      webhookSecret: "test-webhook-secret",
    };
    const adapter = createSonarrAdapter(config);
    const rawBody = JSON.stringify({
      eventType: "Download",
      eventId: "event-1",
      downloadId: "700",
      progress: 35,
      series: { title: "Webhook Series" },
      downloadClient: "qBittorrent",
    });
    const event = adapter.parseAcquisitionWebhook!({
      rawBody,
      headers: { "x-webhook-signature": signWebhook(rawBody) },
    });
    assert.equal(event?.providerJobId, "700");
    assert.equal(event?.lifecycle, "completed");
    assert.equal(event?.progress, 0.35);
    assert.equal(event?.metadata?.providerWebhookEventId, "event-1");
    assert.throws(
      () => adapter.parseAcquisitionWebhook!({
        rawBody,
        headers: { "x-webhook-signature": signWebhook(rawBody, "wrong-secret") },
      }),
      /signature is invalid/i,
    );
  });

  test("webhooks update only the matching owner job and deduplicate delivery", async () => {
    mockFetch((url) => {
      if (url.pathname.endsWith("/system/status")) return jsonResponse({ version: "4.0.0" });
      if (url.pathname.endsWith("/command")) return jsonResponse({ id: 702 });
      throw new Error(`Unexpected URL ${url}`);
    });
    const ownerA = await acquisition.createAcquisitionJob({
      mediaType: "series",
      title: "Owner A",
      externalId: "1",
      providerId: "sonarr",
      start: true,
    }, "webhook-owner-a");
    const ownerB = await acquisition.createAcquisitionJob({
      mediaType: "series",
      title: "Owner B",
      externalId: "2",
      providerId: "sonarr",
      start: false,
    }, "webhook-owner-b");
    const grabbedEvent = {
      providerJobId: ownerA!.providerJobId!,
      status: "Grab",
      lifecycle: "active" as const,
      progress: 0.2,
      providerReference: "qBittorrent",
      detail: "Owner A download was grabbed.",
      eventId: "event-owner-a-grab",
      metadata: { providerWebhookEventId: "event-owner-a-grab" },
    };
    const event = {
      providerJobId: ownerA!.providerJobId!,
      status: "Download",
      lifecycle: "completed" as const,
      progress: 0.6,
      providerReference: "qBittorrent",
      detail: "Owner A download completed.",
      eventId: "event-owner-a",
      metadata: { providerWebhookEventId: "event-owner-a" },
    };
    const grabbed = acquisition.handleAcquisitionWebhook("sonarr", grabbedEvent);
    assert.equal(grabbed.status, "processed");
    assert.equal(grabbed.job?.state, "downloading");
    const handled = acquisition.handleAcquisitionWebhook("sonarr", event);
    assert.equal(handled.status, "processed");
    assert.equal(handled.job?.ownerId, "webhook-owner-a");
    assert.equal(handled.job?.state, "processing");
    assert.equal(acquisition.readAcquisitionJob(ownerB!.id, "webhook-owner-b")?.state, "planned");

    const duplicate = acquisition.handleAcquisitionWebhook("sonarr", event);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.job?.events.length, handled.job?.events.length);
  });
});