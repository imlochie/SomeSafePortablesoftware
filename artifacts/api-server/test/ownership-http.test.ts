import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import app from "../src/app";
import { archiveDb } from "../src/lib/archive-db";
import { ensureReviewItem } from "../src/services/review-queue";

process.env.ARCHIVE_ASSISTANT_ALLOW_TEST_AUTH = "1";

test("HTTP owner identity scopes review reads and decisions", async () => {
  const ownerA = `http-owner-a-${Date.now()}`;
  const ownerB = `http-owner-b-${Date.now()}`;
  const review = ensureReviewItem(ownerA, {
    kind: "naming_proposal",
    subjectKey: `http-owner-review-${Date.now()}`,
    title: "Owner-scoped review",
    payload: { planId: "owner-scoped-plan", mappings: [] },
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (ownerId: string, path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-test-owner-id": ownerId, ...(init.headers ?? {}) },
  });
  try {
    const ownerRead = await request(ownerA, `/api/review-items/${review.id}`);
    assert.equal(ownerRead.status, 200);
    const intruderRead = await request(ownerB, `/api/review-items/${review.id}`);
    assert.equal(intruderRead.status, 404);
    const intruderApproval = await request(ownerB, `/api/review-items/${review.id}/approve`, { method: "POST", body: "{}" });
    assert.equal(intruderApproval.status, 400);
    const ownerApproval = await request(ownerA, `/api/review-items/${review.id}/approve`, { method: "POST", body: "{}" });
    assert.equal(ownerApproval.status, 200);
    const stored = archiveDb.prepare("SELECT owner_id, state FROM review_item WHERE id = ?").get(review.id) as { owner_id: string; state: string };
    assert.equal(stored.owner_id, ownerA);
    assert.equal(stored.state, "approved");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
