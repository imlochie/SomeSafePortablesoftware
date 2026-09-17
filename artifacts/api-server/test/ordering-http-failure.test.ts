import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import app from "../src/app";
import { archiveDb, writeSettings } from "../src/lib/archive-db";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "archive-ordering-http-failure-"));
  writeSettings({ dataDirectory: root, downloadDirectory: root, temporaryDirectory: root, archiveDirectory: root });
  const a = join(root, "A.mp4"); const b = join(root, "B.mp4"); await writeFile(a, "A"); await writeFile(b, "B");
  const owner = "__local__";
  const insert = archiveDb.prepare(`INSERT INTO file_record (path,size_bytes,checksum,owner_id,filename,relative_path,scan_status,archive_root) VALUES (?,?,?,?,?,?, 'active', ?)`);
  const aid = Number(insert.run(a, 1, "a", owner, "A.mp4", "A.mp4", root).lastInsertRowid);
  const bid = Number(insert.run(b, 1, "b", owner, "B.mp4", "B.mp4", root).lastInsertRowid);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = (id: string) => ({ proposalId: id, collectionId: id, hypothesis: "chronological_descending", confidence: "high", evidence: ["dates"], unknowns: [], expectedCollectionMembership: [a, b], expectedSourceState: {}, expectedDestinationState: {}, sourceMappings: [{ mappingId: "a", originalPath: a, proposedPath: b, currentEpisode: 1, proposedEpisode: 2, expectedSourceIdentity: `file_record:${aid}:a` }, { mappingId: "b", originalPath: b, proposedPath: a, currentEpisode: 2, proposedEpisode: 1, expectedSourceIdentity: `file_record:${bid}:b` }] });
  const cleanup = async () => { archiveDb.prepare("DELETE FROM file_record WHERE owner_id=? AND path IN (?,?)").run(owner, a, b); await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); await rm(root, { recursive: true, force: true }); };
  return { request, body, cleanup, root, a, b, owner };
}

test("public ordering routes reject pending, deferred, and rejected proposals", async () => {
  const fixture = await setup();
  try {
    for (const decision of ["pending", "defer", "reject"] as const) {
      const id = `http-review-${decision}-${Date.now()}`;
      const created = await fixture.request("/api/archive/ordering-proposals", { method: "POST", body: JSON.stringify(fixture.body(id)) });
      assert.equal(created.status, 201); const proposal = await created.json() as Record<string, any>;
      if (decision !== "pending") {
        const changed = await fixture.request(`/api/review-items/${proposal.reviewItemId}/${decision}`, { method: "POST", body: "{}" });
        assert.equal(changed.status, 200);
      }
      const operation = await fixture.request("/api/archive-operations", { method: "POST", body: JSON.stringify({ proposalId: id, action: "rename", sourceKind: "ordering" }) });
      assert.equal(operation.status, 400);
    }
  } finally { await fixture.cleanup(); }
});

test("public proposal route derives stale validation after a collection member is removed", async () => {
  const fixture = await setup();
  try {
    const id = `http-stale-${Date.now()}`;
    const created = await fixture.request("/api/archive/ordering-proposals", { method: "POST", body: JSON.stringify(fixture.body(id)) });
    assert.equal(created.status, 201); const proposal = await created.json() as Record<string, any>;
    const approval = await fixture.request(`/api/review-items/${proposal.reviewItemId}/approve`, { method: "POST", body: "{}" }); assert.equal(approval.status, 200);
    archiveDb.prepare("UPDATE file_record SET scan_status = 'missing' WHERE owner_id = ? AND path = ?").run(fixture.owner, fixture.b);
    const fetched = await fixture.request(`/api/archive/ordering-proposals/${id}`); assert.equal(fetched.status, 200);
    const current = await fetched.json() as Record<string, any>; assert.notEqual(current.validationState, "CURRENT");
    const operation = await fixture.request("/api/archive-operations", { method: "POST", body: JSON.stringify({ proposalId: id, action: "rename", sourceKind: "ordering" }) });
    assert.equal(operation.status, 400);
  } finally { await fixture.cleanup(); }
});

test("public proposal routes reject changed source identity", async () => {
  const fixture = await setup();
  try {
    const id = `http-identity-${Date.now()}`;
    const created = await fixture.request("/api/archive/ordering-proposals", { method: "POST", body: JSON.stringify(fixture.body(id)) });
    const proposal = await created.json() as Record<string, any>;
    await fixture.request(`/api/review-items/${proposal.reviewItemId}/approve`, { method: "POST", body: "{}" });
    archiveDb.prepare("UPDATE file_record SET checksum = ? WHERE owner_id = ? AND path = ?").run("changed", fixture.owner, fixture.a);
    const fetched = await fixture.request(`/api/archive/ordering-proposals/${id}`); assert.notEqual((await fetched.json()).validationState, "CURRENT");
    const operation = await fixture.request("/api/archive-operations", { method: "POST", body: JSON.stringify({ proposalId: id, action: "rename", sourceKind: "ordering" }) }); assert.equal(operation.status, 400);
  } finally { await fixture.cleanup(); }
});

test("public ordering routes reject unapproved proposals and deduplicate approved operations", async () => {
  const fixture = await setup();
  try {
    const id = `http-failure-${Date.now()}`;
    const created = await fixture.request("/api/archive/ordering-proposals", { method: "POST", body: JSON.stringify(fixture.body(id)) });
    assert.equal(created.status, 201); const proposal = await created.json() as Record<string, any>;
    const pending = await fixture.request("/api/archive-operations", { method: "POST", body: JSON.stringify({ proposalId: id, action: "rename", sourceKind: "ordering" }) });
    assert.equal(pending.status, 400);
    const approval = await fixture.request(`/api/review-items/${proposal.reviewItemId}/approve`, { method: "POST", body: "{}" }); assert.equal(approval.status, 200);
    const first = await fixture.request("/api/archive-operations", { method: "POST", body: JSON.stringify({ proposalId: id, action: "rename", sourceKind: "ordering" }) }); assert.equal(first.status, 201);
    const second = await fixture.request("/api/archive-operations", { method: "POST", body: JSON.stringify({ proposalId: id, action: "rename", sourceKind: "ordering", batch: [{ id: "malicious", originalPath: "/bad", temporaryPath: "/bad-tmp", finalPath: "/bad-final", state: "planned" }] }) });
    assert.equal(second.status, 201); assert.deepEqual((await second.json()).batch, (await first.clone().json()).batch);
  } finally { await fixture.cleanup(); }
});
