import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, describe, test } from "node:test";
import type { IntegrationConfiguration } from "../src/integrations/config";
import {
  createProwlarrAdapter,
  createQBittorrentAdapter,
  createRadarrAdapter,
  createSonarrAdapter,
  IntegrationHttpError,
  requestJson,
} from "../src/integrations";
import app from "../src/app";
import { archiveDb, readEvents } from "../src/lib/archive-db";
import { runtimeConfig } from "../src/lib/runtime-config";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config(overrides: Partial<IntegrationConfiguration> = {}): IntegrationConfiguration {
  return {
    endpoint: "http://integration.test",
    credentialsConfigured: true,
    apiKey: "test-api-key",
    username: "test-user",
    password: "test-password",
    ...overrides,
  };
}

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

async function startApiServer() {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function stopApiServer(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("HTTP integration adapters", { concurrency: false }, () => {
  test("Sonarr and Radarr support health, lookup, missing media, queue, and search commands", async () => {
    const requested: string[] = [];
    mockFetch((url) => {
      requested.push(url.pathname + url.search);
      if (url.pathname.endsWith("/system/status")) return jsonResponse({ version: "4.0.0" });
      if (url.pathname.endsWith("/series/lookup")) {
        return jsonResponse([{ id: 42, title: "Example Series", year: 2026, tvdbId: 4242 }]);
      }
      if (url.pathname.endsWith("/movie/lookup")) {
        return jsonResponse([{ id: 84, title: "Example Movie", year: 2026, tmdbId: 8484 }]);
      }
      if (url.pathname.endsWith("/wanted/missing")) return jsonResponse({ records: [] });
      if (url.pathname.endsWith("/queue")) {
        return jsonResponse({ records: [{ id: 7, status: "downloading", size: 100, sizeleft: 25 }] });
      }
      if (url.pathname.endsWith("/command")) return jsonResponse({ id: 99, status: "started" });
      throw new Error(`Unexpected URL ${url}`);
    });

    for (const [adapter, id, mediaType, lookupPath] of [
      [createSonarrAdapter(config()), "sonarr", "series", "/series/lookup"],
      [createRadarrAdapter(config()), "radarr", "movie", "/movie/lookup"],
    ] as const) {
      const status = await adapter.getStatus("__local__");
      assert.equal(status.state, "operational");
      assert.equal(status.reachable, true);
      assert.equal(status.operational, true);

      const lookup = await adapter.getCapability("media_lookup")!({ query: "Example" }, { ownerId: "__local__" });
      assert.equal(lookup.records.length, 1);
      assert.equal(lookup.records[0]?.mediaType, mediaType);

      const missing = await adapter.getCapability("missing_media_discovery")!({}, { ownerId: "__local__" });
      assert.deepEqual(missing.items, []);

      const queue = await adapter.getCapability("acquisition_job_status")!({}, { ownerId: "__local__" });
      assert.equal(queue.jobs[0]?.progress, 0.75);

      const request = await adapter.getCapability("acquisition_job_creation")!({
        mediaType,
        title: "Example",
        externalId: mediaType === "series" ? "42" : "84",
      }, { ownerId: "__local__" });
      assert.equal(request.accepted, true);
      assert.equal(request.jobId, "99");
      assert.ok(requested.some((path) => path.endsWith(lookupPath + "?term=Example")));
      assert.ok(requested.some((path) => path.endsWith("/command")));
      assert.equal(id, adapter.id);
    }
  });

  test("Prowlarr returns real search and indexer data, including empty results", async () => {
    mockFetch((url) => {
      if (url.pathname.endsWith("/system/status")) return jsonResponse({ version: "1.0.0" });
      if (url.pathname.endsWith("/search")) {
        return jsonResponse([{ guid: "guid-1", title: "Release", indexer: "Indexer A", seeders: 12 }]);
      }
      if (url.pathname.endsWith("/indexer/3")) {
        return jsonResponse({ id: 3, name: "Indexer A", enable: true });
      }
      if (url.pathname.endsWith("/indexer")) return jsonResponse([]);
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = createProwlarrAdapter(config());
    assert.equal((await adapter.getStatus("__local__")).operational, true);
    const search = await adapter.getCapability("archive_search")!({ query: "Release" }, { ownerId: "__local__" });
    assert.equal(search.records[0]?.externalId, "guid-1");
    const emptyHosts = await adapter.getCapability("host_lookup")!({ query: "missing" }, { ownerId: "__local__" });
    assert.equal(emptyHosts.reachable, false);
    const source = await adapter.getCapability("source_inspection")!({ sourceId: "3" }, { ownerId: "__local__" });
    assert.equal(source.available, true);
  });

  test("qBittorrent logs in, creates a job, and reports lifecycle status", async () => {
    mockFetch((url) => {
      if (url.pathname.endsWith("/auth/login")) {
        return textResponse("Ok.", 200, { "set-cookie": "SID=session-1; Path=/" });
      }
      if (url.pathname.endsWith("/app/version")) return textResponse("4.6.0");
      if (url.pathname.endsWith("/torrents/add")) return textResponse("Ok.");
      if (url.pathname.endsWith("/torrents/info")) {
        return jsonResponse([{ hash: "abc123", name: "Example", state: "downloading", progress: 0.5 }]);
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = createQBittorrentAdapter(config({ apiKey: null }));
    assert.equal((await adapter.getStatus("__local__")).operational, true);
    const created = await adapter.getCapability("acquisition_job_creation")!({
      mediaType: "movie",
      title: "Example",
      sourceId: "magnet:?xt=urn:btih:abc123",
    }, { ownerId: "__local__" });
    assert.equal(created.accepted, true);
    const jobs = await adapter.getCapability("acquisition_job_status")!({ jobId: "abc123" }, { ownerId: "__local__" });
    assert.equal(jobs.jobs[0]?.progress, 0.5);
  });

  test("configured services report authentication failures without exposing secrets", async () => {
    mockFetch(() => jsonResponse({ error: "nope" }, 401));
    const adapter = createSonarrAdapter(config());
    const status = await adapter.getStatus("__local__");
    assert.equal(status.state, "error");
    assert.equal(status.operational, false);
    assert.equal(status.reachable, true);
    assert.doesNotMatch(status.detail, /test-api-key|test-password/);
    await assert.rejects(
      adapter.getCapability("media_lookup")!({ query: "Example" }, { ownerId: "__local__" }),
      (error: unknown) => error instanceof IntegrationHttpError && error.kind === "authentication",
    );
  });

  test("timeouts, unreachable hosts, and malformed responses fail explicitly", async () => {
    mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    await assert.rejects(
      requestJson(config(), "sonarr", "/api/v3/system/status", { timeoutMs: 5 }),
      (error: unknown) => error instanceof IntegrationHttpError && error.kind === "timeout",
    );

    mockFetch(() => Promise.reject(new Error("connection refused")));
    const unreachable = await createRadarrAdapter(config()).getStatus("__local__");
    assert.equal(unreachable.state, "error");
    assert.equal(unreachable.reachable, false);

    mockFetch(() => jsonResponse({ records: "not-an-array" }));
    await assert.rejects(
      createSonarrAdapter(config()).getCapability("media_lookup")!({ query: "Example" }, { ownerId: "__local__" }),
      (error: unknown) => error instanceof IntegrationHttpError && error.kind === "malformed",
    );
  });

  test("authenticated webhook rotations are recorded only in the operator's system history", async () => {
    const ownerId = runtimeConfig.localOwnerId;
    const otherOwnerId = "webhook-rotation-other-owner";
    const settingKeys = ["integration.webhook.sonarr", "integration.webhook.radarr"];
    archiveDb.prepare("DELETE FROM setting WHERE key IN (?, ?)").run(...settingKeys);
    archiveDb
      .prepare("DELETE FROM system_event WHERE owner_id IN (?, ?) AND source = 'integrations'")
      .run(ownerId, otherOwnerId);

    const { server, baseUrl } = await startApiServer();
    try {
      const rotate = (provider: "sonarr" | "radarr", body: Record<string, unknown>) =>
        originalFetch(`${baseUrl}/api/integrations/webhooks/${provider}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      const sonarrSuccess = await rotate("sonarr", {
        secret: "sonarr-route-secret-1234",
        mode: "cutover",
      });
      assert.equal(sonarrSuccess.status, 200);

      const radarrSuccess = await rotate("radarr", {
        secret: "radarr-route-secret-1234",
        mode: "overlap",
        overlapMinutes: 30,
      });
      assert.equal(radarrSuccess.status, 200);

      const sonarrFailure = await rotate("sonarr", {
        secret: "too-short",
        mode: "cutover",
      });
      assert.equal(sonarrFailure.status, 400);

      const radarrFailure = await rotate("radarr", {
        secret: "radarr-route-secret-5678",
        mode: "overlap",
      });
      assert.equal(radarrFailure.status, 400);

      const ownerEvents = readEvents(ownerId, 100).filter(
        (event) => event.source === "integrations" && event.message.includes("Webhook secret rotated"),
      );
      assert.equal(ownerEvents.length, 2);
      assert.deepEqual(
        ownerEvents.map((event) => event.operatorId).sort(),
        [ownerId, ownerId],
      );
      assert.ok(ownerEvents.some((event) => /sonarr/i.test(event.message)));
      assert.ok(ownerEvents.some((event) => /radarr/i.test(event.message)));
      assert.ok(ownerEvents.every((event) => event.retentionClass === "security"));
      assert.ok(!ownerEvents.some((event) => /sonarr-route-secret|radarr-route-secret/.test(JSON.stringify(event))));

      const historyResponse = await originalFetch(`${baseUrl}/api/system/events`);
      assert.equal(historyResponse.status, 200);
      const history = await historyResponse.json() as Array<{
        operatorId: string | null;
        message: string;
      }>;
      assert.equal(
        history.filter((event) => event.message.includes("Webhook secret rotated")).length,
        2,
      );
      assert.ok(history.every((event) => event.operatorId === null || event.operatorId === ownerId));

      const otherOwnerEvents = readEvents(otherOwnerId, 100);
      assert.equal(otherOwnerEvents.length, 0);
    } finally {
      await stopApiServer(server);
      archiveDb.prepare("DELETE FROM setting WHERE key IN (?, ?)").run(...settingKeys);
      archiveDb
        .prepare("DELETE FROM system_event WHERE owner_id IN (?, ?) AND source = 'integrations'")
        .run(ownerId, otherOwnerId);
    }
  });
});
