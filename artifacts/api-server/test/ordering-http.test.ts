import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import app from "../src/app";
import { archiveDb, writeSettings } from "../src/lib/archive-db";
import { ensureReviewItem } from "../src/services/review-queue";

async function api() {
  const root = await mkdtemp(join(tmpdir(), "archive-ordering-http-"));
  writeSettings({ dataDirectory: root, downloadDirectory: root, temporaryDirectory: root, archiveDirectory: root });
  const a = join(root, "A.mp4"); const b = join(root, "B.mp4");
  await writeFile(a, "A"); await writeFile(b, "B");
  const owner = "__local__";
  const insert = archiveDb.prepare(`INSERT INTO file_record (path, size_bytes, checksum, fingerprint, owner_id, filename, relative_path, scan_status, archive_root) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`);
  const aId = Number(insert.run(a, 1, "a", null, owner, "A.mp4", "A.mp4", root).lastInsertRowid);
  const bId = Number(insert.run(b, 1, "b", null, owner, "B.mp4", "B.mp4", root).lastInsertRowid);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const cleanup = async () => { archiveDb.prepare("DELETE FROM file_record WHERE owner_id = ? AND path IN (?, ?)").run(owner, a, b); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); };
  return { root, a, b, aId, bId, request, cleanup };
}

test("public proposal-backed operation lifecycle performs a swap and exact rollback", async () => {
  const fixture = await api();
  try {
    const proposalBody = {
      proposalId: "http-ordering-swap",
      collectionId: "http-season-1",
      hypothesis: "chronological_descending",
      confidence: "high",
      evidence: ["explicit publication dates"],
      unknowns: [],
      expectedCollectionMembership: [fixture.a, fixture.b],
      expectedSourceState: {},
      expectedDestinationState: {},
      sourceMappings: [
        { mappingId: "a", originalPath: fixture.a, proposedPath: fixture.b, currentEpisode: 1, proposedEpisode: 2, expectedSourceIdentity: `file_record:${fixture.aId}:a` },
        { mappingId: "b", originalPath: fixture.b, proposedPath: fixture.a, currentEpisode: 2, proposedEpisode: 1, expectedSourceIdentity: `file_record:${fixture.bId}:b` },
      ],
    };
    const created = await fixture.request("/api/archive/ordering-proposals", { method: "POST", body: JSON.stringify(proposalBody) });
    assert.equal(created.status, 201); const proposal = await created.json() as Record<string, any>;
    assert.equal(proposal.proposalId, "http-ordering-swap"); assert.equal(proposal.reviewState, "pending");
    const fetched = await fixture.request(`/api/archive/ordering-proposals/${proposal.proposalId}`); assert.equal(fetched.status, 200);
    const fetchedBody = await fetched.json() as Record<string, any>; assert.equal(fetchedBody.proposalVersion, proposal.proposalVersion);
    for (const field of ["proposalId", "proposalVersion", "reviewItemId", "collectionId", "state", "reviewState", "validationState", "validation", "staleStatus", "hypothesis", "confidence", "evidence", "unknowns", "sourceMappings", "linkedOperationId"]) assert.ok(field in fetchedBody, `missing proposal response field: ${field}`);
    const approved = await fixture.request(`/api/review-items/${proposal.reviewItemId}/approve`, { method: "POST", body: "{}" }); assert.equal(approved.status, 200);
    const operationResponse = await fixture.request("/api/archive-operations", { method: "POST", body: JSON.stringify({ proposalId: proposal.proposalId, action: "rename", sourceKind: "ordering" }) });
    assert.equal(operationResponse.status, 201); const operation = await operationResponse.json() as Record<string, any>;
    assert.equal(operation.proposalId, proposal.proposalId); assert.equal(operation.batch.length, 2);
    const refreshBeforeCompletion = await fixture.request(`/api/archive-operations/${operation.id}/refresh-providers`, { method: "POST", body: JSON.stringify({ confirmed: true, providers: ["plex"] }) });
    assert.equal(refreshBeforeCompletion.status, 400);
    const preflight = await fixture.request(`/api/archive-operations/${operation.id}/preflight`, { method: "POST", body: "{}" }); assert.equal(preflight.status, 200);
    const execute = await fixture.request(`/api/archive-operations/${operation.id}/execute`, { method: "POST", body: JSON.stringify({ confirmed: true }) }); assert.equal(execute.status, 200);
    assert.equal(await readFile(fixture.a, "utf8"), "B"); assert.equal(await readFile(fixture.b, "utf8"), "A");
    const executeAgain = await fixture.request(`/api/archive-operations/${operation.id}/execute`, { method: "POST", body: JSON.stringify({ confirmed: true }) }); assert.equal(executeAgain.status, 200);
    assert.equal(await readFile(fixture.a, "utf8"), "B"); assert.equal(await readFile(fixture.b, "utf8"), "A");
    const refreshWithoutConfirmation = await fixture.request(`/api/archive-operations/${operation.id}/refresh-providers`, { method: "POST", body: JSON.stringify({ providers: ["plex"] }) });
    assert.equal(refreshWithoutConfirmation.status, 400);
    const refreshWithInvalidProvider = await fixture.request(`/api/archive-operations/${operation.id}/refresh-providers`, { method: "POST", body: JSON.stringify({ confirmed: true, providers: ["unknown"] }) });
    assert.equal(refreshWithInvalidProvider.status, 400);
    const refreshBeforeRollback = await fixture.request(`/api/archive-operations/${operation.id}/refresh-providers`, { method: "POST", body: JSON.stringify({ confirmed: true, providers: ["plex", "jellyfin"] }) });
    assert.equal(refreshBeforeRollback.status, 202);
    const refreshBody = await refreshBeforeRollback.json() as Record<string, any>;
    assert.ok(Array.isArray(refreshBody.started));
    assert.ok(Array.isArray(refreshBody.skipped));
    assert.equal(refreshBody.operationId, operation.id);
    const rollback = await fixture.request(`/api/archive-operations/${operation.id}/rollback`, { method: "POST", body: JSON.stringify({ confirmed: true }) }); assert.equal(rollback.status, 200);
    assert.equal(await readFile(fixture.a, "utf8"), "A"); assert.equal(await readFile(fixture.b, "utf8"), "B");
    const rollbackAgain = await fixture.request(`/api/archive-operations/${operation.id}/rollback`, { method: "POST", body: JSON.stringify({ confirmed: true }) }); assert.equal(rollbackAgain.status, 200);
    assert.equal(await readFile(fixture.a, "utf8"), "A"); assert.equal(await readFile(fixture.b, "utf8"), "B");
    const refreshAfterRollback = await fixture.request(`/api/archive-operations/${operation.id}/refresh-providers`, { method: "POST", body: JSON.stringify({ confirmed: true, providers: ["plex"] }) });
    assert.equal(refreshAfterRollback.status, 202);
  } finally { await fixture.cleanup(); }
});

test("Power Renamer refuses an approved plan when source identity changes", async () => {
  const fixture = await api();
  try {
    const review = ensureReviewItem("__local__", {
      kind: "naming_proposal",
      subjectKey: "http-power-stale-plan",
      title: "Stale Power Renamer plan",
      payload: {
        planId: "http-power-stale-plan",
        mappings: [{ id: "record-a", sourcePath: fixture.a, destinationPath: join(fixture.root, "renamed-A.mp4") }],
        expectedSourceIdentities: { [fixture.a]: `file_record:${fixture.aId}:a` },
      },
    });
    const approved = await fixture.request(`/api/review-items/${review.id}/approve`, { method: "POST", body: "{}" });
    assert.equal(approved.status, 200);
    archiveDb.prepare("UPDATE file_record SET checksum = ? WHERE owner_id = ? AND id = ?").run("changed", "__local__", fixture.aId);
    const response = await fixture.request("/api/archive/power-renamer/operations", { method: "POST", body: JSON.stringify({ reviewItemId: review.id }) });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /STALE_POWER_RENAMER_PLAN/);
  } finally { await fixture.cleanup(); }
});
