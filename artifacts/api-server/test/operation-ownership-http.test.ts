import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import app from "../src/app";
import { ensureReviewItem, approveReviewItem } from "../src/services/review-queue";
import { createArchiveOperation } from "../src/services/archive-operations";
import { writeSettings } from "../src/lib/archive-db";

process.env.ARCHIVE_ASSISTANT_ALLOW_TEST_AUTH = "1";

test("HTTP owner isolation protects archive operation mutations and provider refresh", async () => {
  const ownerA = `operation-owner-a-${Date.now()}`;
  const ownerB = `operation-owner-b-${Date.now()}`;
  const review = ensureReviewItem(ownerA, {
    kind: "naming_proposal",
    subjectKey: `operation-owner-review-${Date.now()}`,
    title: "Owner-scoped operation",
    payload: { planId: "operation-owner-plan", mappings: [] },
  });
  approveReviewItem(review.id, ownerA, "Owner A approval.");
  writeSettings({ dataDirectory: "/tmp", downloadDirectory: "/tmp", temporaryDirectory: "/tmp", archiveDirectory: "/tmp" });
  const operation = createArchiveOperation({
    action: "rename",
    sourceKind: "test",
    sourceId: "owner-isolation",
    reviewItemId: review.id,
    batch: [{ id: "owner-step", originalPath: "/tmp/source.mkv", temporaryPath: "/tmp/source.tmp", finalPath: "/tmp/destination.mkv", state: "planned" }],
  }, ownerA);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-test-owner-id": ownerB, ...(init.headers ?? {}) },
  });
  try {
    for (const path of [`/api/archive-operations/${operation.id}`, `/api/archive-operations/${operation.id}/provider-status`]) {
      const response = await request(path);
      assert.equal(response.status, 404, `cross-owner GET must reject ${path}`);
    }
    for (const [action, body] of [
      ["preflight", {}],
      ["execute", { confirmed: true }],
      ["rollback", { confirmed: true }],
      ["refresh-providers", { confirmed: true, providers: ["plex"] }],
    ] as const) {
      const response = await request(`/api/archive-operations/${operation.id}/${action}`, { method: "POST", body: JSON.stringify(body) });
      assert.ok([400, 404].includes(response.status), `cross-owner ${action} must reject`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
