import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, describe, test } from "node:test";
import app from "../src/app";
import { archiveDb } from "../src/lib/archive-db";

process.env.ARCHIVE_ASSISTANT_ALLOW_TEST_AUTH = "1";

async function start() {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stop(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function headers(owner: string) {
  return { "x-test-owner-id": owner };
}

describe("provider refresh HTTP boundary", { concurrency: false }, () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl = "";
  const ownerA = `refresh-http-a-${Date.now()}`;
  const ownerB = `refresh-http-b-${Date.now()}`;

  test("state and history preserve attempted, successful, and authoritative refreshes", async () => {
    ({ server, baseUrl } = await start());
    archiveDb.prepare(`
      INSERT INTO provider_refresh
        (refresh_id, owner_id, provider, started_at, completed_at, status, snapshot_completeness, item_count, authoritative, reason, snapshot_reference)
      VALUES ('http-r1', ?, 'plex', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', 'synced', 'complete', 2, 1, NULL, 'provider-refresh:http-r1')
    `).run(ownerA);
    archiveDb.prepare(`
      INSERT INTO provider_refresh
        (refresh_id, owner_id, provider, started_at, completed_at, status, snapshot_completeness, item_count, authoritative, reason, snapshot_reference)
      VALUES ('http-r2', ?, 'plex', '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:01.000Z', 'sync_error', 'unknown', NULL, 0, 'timeout', 'provider-refresh:http-r2')
    `).run(ownerA);
    const response = await fetch(`${baseUrl}/api/provider/refresh?provider=plex`, { headers: headers(ownerA) });
    assert.equal(response.status, 200);
    const state = await response.json() as { lastAttemptedRefresh: { refreshId: string }; lastSuccessfulRefresh: { refreshId: string }; currentAuthoritativeRefresh: { refreshId: string } };
    assert.equal(state.lastAttemptedRefresh.refreshId, "http-r2");
    assert.equal(state.lastSuccessfulRefresh.refreshId, "http-r1");
    assert.equal(state.currentAuthoritativeRefresh.refreshId, "http-r1");

    const historyResponse = await fetch(`${baseUrl}/api/provider/refresh/history?provider=plex&page=1&pageSize=1`, { headers: headers(ownerA) });
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json() as { results: Array<{ refreshId: string }>; pagination: { pageSize: number } };
    assert.equal(history.pagination.pageSize, 1);
    assert.equal(history.results.length, 1);
    assert.equal(history.results[0].refreshId, "http-r2");
  });

  test("invalid queries and owner isolation are enforced at HTTP boundary", async () => {
    const invalidProvider = await fetch(`${baseUrl}/api/provider/refresh?provider=nope`, { headers: headers(ownerA) });
    assert.equal(invalidProvider.status, 400);
    const invalidPage = await fetch(`${baseUrl}/api/provider/refresh/history?provider=plex&page=banana`, { headers: headers(ownerA) });
    assert.equal(invalidPage.status, 400);
    const otherOwner = await fetch(`${baseUrl}/api/provider/refresh?provider=plex`, { headers: headers(ownerB) });
    assert.equal(otherOwner.status, 200);
    const otherState = await otherOwner.json() as { lastAttemptedRefresh: unknown };
    assert.equal(otherState.lastAttemptedRefresh, null);
  });

  test("finding lineage is owner-scoped and carries the real snapshot reference", async () => {
    archiveDb.prepare(`
      INSERT INTO review_item (id, owner_id, kind, subject_key, title, state, payload_json)
      VALUES (99001, ?, 'archive_finding', 'archive-finding:http', 'HTTP lineage finding', 'pending', ?)
    `).run(ownerA, JSON.stringify({ classification: "quality_conflict", evidenceKey: "http-evidence", snapshot: { provider: "plex", refreshId: "http-r1", capturedAt: "2026-01-01T00:00:01.000Z" } }));
    archiveDb.prepare(`
      INSERT INTO review_item_observation (review_item_id, owner_id, subject_key, evidence_key, payload_json, status, observed_at)
      VALUES (99001, ?, 'archive-finding:http', 'http-evidence', '{}', 'active', '2026-01-01T00:00:01.000Z')
    `).run(ownerA);
    const response = await fetch(`${baseUrl}/api/archive/reconciliation/findings/99001/lineage`, { headers: headers(ownerA) });
    assert.equal(response.status, 200);
    const lineage = await response.json() as { provider: { refreshId: string; snapshotReference: string }; currentObservation: { evidenceKey: string } };
    assert.equal(lineage.provider.refreshId, "http-r1");
    assert.equal(lineage.provider.snapshotReference, "provider-refresh:http-r1");
    assert.equal(lineage.currentObservation.evidenceKey, "http-evidence");
    const crossOwner = await fetch(`${baseUrl}/api/archive/reconciliation/findings/99001/lineage`, { headers: headers(ownerB) });
    assert.equal(crossOwner.status, 404);
  });

  after(async () => {
    if (server) await stop(server);
  });
});
