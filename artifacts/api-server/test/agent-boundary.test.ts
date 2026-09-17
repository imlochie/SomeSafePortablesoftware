import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";
import app from "../src/app";
import { archiveDb, addEvent } from "../src/lib/archive-db";
import { runtimeConfig } from "../src/lib/runtime-config";
import { approveReviewItem, ensureReviewItem } from "../src/services/review-queue";

let server: Server;
let baseUrl: string;
const ownerId = runtimeConfig.localOwnerId;

before(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("agent boundary", { concurrency: false }, () => {
  test("capabilities describe enforced approval and preflight policy", async () => {
    const response = await fetch(`${baseUrl}/api/agent/capabilities`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      agent: { id: "arena", mode: "local" },
      capabilities: { read: true, plan: true, operate: true },
      operationPolicy: {
        approvalRequired: true,
        preflightRequired: true,
        directMutation: false,
        providerExecution: false,
      },
    });
  });

  test("context returns bounded redacted evidence without mutation authority", async () => {
    const response = await fetch(`${baseUrl}/api/agent/context`);
    assert.equal(response.status, 200);
    const context = await response.json() as {
      source: { contract: string; ownerScoped: boolean };
      safety: { approvalRequired: boolean; preflightRequired: boolean; directMutation: boolean };
      archive: { summary: unknown; attention: unknown[] };
      personal: { viewingEvidence: unknown[] };
    };
    assert.equal(context.source.contract, "agent-context-v1");
    assert.equal(context.source.ownerScoped, true);
    assert.equal(context.safety.approvalRequired, true);
    assert.equal(context.safety.preflightRequired, true);
    assert.equal(context.safety.directMutation, false);
    assert.ok(context.archive.summary);
    assert.ok(Array.isArray(context.archive.attention));
    assert.ok(Array.isArray(context.personal.viewingEvidence));
    assert.doesNotMatch(JSON.stringify(context), /\/tmp\//);
  });

  test("event stream returns owner-scoped persisted events and can disconnect", async () => {
    addEvent("info", "Agent boundary test event", "agent-test", ownerId);
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /system\.event/);
    assert.match(text, /Agent boundary test event/);
    controller.abort();
    await reader.cancel().catch(() => {});
  });

  test("operation planning persists an approved proposal without touching files or providers", async () => {
    const review = ensureReviewItem(ownerId, {
      kind: "operation_approval",
      subjectKey: "agent-plan-boundary-test",
      title: "Plan agent boundary test operation",
      payload: { source: "agent-boundary-test" },
    });
    approveReviewItem(review.id, ownerId, "bounded plan test");
    const before = archiveDb.prepare("SELECT COUNT(*) AS count FROM archive_operation WHERE owner_id = ?").get(ownerId) as { count: number };
    const response = await fetch(`${baseUrl}/api/operations/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "rename",
        sourceKind: "agent-test",
        sourcePath: "/tmp/agent-boundary-source.mkv",
        destinationPath: "/tmp/agent-boundary-destination.mkv",
        reviewItemId: review.id,
        dryRun: true,
      }),
    });
    assert.equal(response.status, 201);
    const operation = await response.json() as { status: string; dryRun: boolean; events: unknown[] };
    assert.equal(operation.status, "planned");
    assert.equal(operation.dryRun, true);
    assert.equal(operation.events.length, 1);
    const after = archiveDb.prepare("SELECT COUNT(*) AS count FROM archive_operation WHERE owner_id = ?").get(ownerId) as { count: number };
    assert.equal(after.count, before.count + 1);
  });
});
