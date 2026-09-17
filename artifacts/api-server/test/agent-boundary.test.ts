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

  test("source monitoring persists outside the archive database and scopes targets", async () => {
    const create = await fetch(`${baseUrl}/api/agent/monitoring/sources`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test public feed", url: "https://example.com/feed.xml", kind: "rss", intervalMinutes: 60, targets: [{ title: "Ted Lasso", mediaType: "episode" }] }),
    });
    assert.equal(create.status, 201);
    const source = await create.json() as { id: string; targets: Array<{ title: string }> };
    assert.equal(source.targets[0].title, "Ted Lasso");
    const list = await fetch(`${baseUrl}/api/agent/monitoring/sources`);
    assert.equal(list.status, 200);
    const listed = await list.json() as { sources: Array<{ id: string }> };
    assert.ok(listed.sources.some((item) => item.id === source.id));
    const removed = await fetch(`${baseUrl}/api/agent/monitoring/sources/${source.id}`, { method: "DELETE" });
    assert.equal(removed.status, 204);
  });

  test("download source inspection selects highest quality and requires approval before queueing", async () => {
    const inspect = await fetch(`${baseUrl}/api/agent/downloads/inspect`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceUrl: "https://example.com/watch?v=archive-agent-test", title: "Agent test source" }),
    });
    assert.equal(inspect.status, 200);
    const proposal = await inspect.json() as {
      contract: string; selected: { formatId: string | null; videoFormatId: string | null; audioFormatId: string | null }; review: { id: number; state: string };
      safety: { queuedOnlyUntilApproval: boolean; postDownloadVerification: boolean };
    };
    assert.equal(proposal.contract, "agent-download-v1");
    assert.equal(proposal.selected.videoFormatId, "401");
    assert.equal(proposal.selected.audioFormatId, "251");
    assert.equal(proposal.review.state, "pending");
    assert.equal(proposal.safety.queuedOnlyUntilApproval, true);
    assert.equal(proposal.safety.postDownloadVerification, true);

    const queue = await fetch(`${baseUrl}/api/agent/downloads/queue`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewItemId: proposal.review.id }),
    });
    assert.equal(queue.status, 400);
    assert.match(String((await queue.json()).error), /approval/i);
  });

  test("research returns source-aware upcoming media and comparison limitations", async () => {
    const response = await fetch(`${baseUrl}/api/agent/research`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeComparisons: true, includeUpcoming: true }),
    });
    assert.equal(response.status, 200);
    const brief = await response.json() as {
      kind: string; contract: string; ownerScoped: boolean; sourcePolicy: { sources: unknown[] };
      upcoming: { items: unknown[] }; recent: unknown[]; comparisons: { items: unknown[] }; comparisonLimitations: string[];
    };
    assert.equal(brief.kind, "archive_research_brief");
    assert.equal(brief.contract, "agent-research-v1");
    assert.equal(brief.ownerScoped, true);
    assert.ok(brief.sourcePolicy.sources.some((source: any) => source.id === "tvmaze"));
    assert.ok(Array.isArray(brief.upcoming.items));
    assert.ok(Array.isArray(brief.recent));
    assert.ok(Array.isArray(brief.comparisons.items));
    assert.ok(brief.comparisonLimitations.some((item) => item.includes("external signals")));
  });

  test("insights returns a prioritized reasoning brief rather than raw archive rows", async () => {
    const response = await fetch(`${baseUrl}/api/agent/insights`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What should I fix first this weekend?", maxActions: 2 }),
    });
    assert.equal(response.status, 200);
    const brief = await response.json() as {
      kind: string; contract: string; question: string; answerRequirements: string[];
      safety: { approvalRequired: boolean; preflightRequired: boolean; directMutation: boolean };
      prioritizedEvidence: unknown[]; unknowns: unknown[];
    };
    assert.equal(brief.kind, "archive_insight_brief");
    assert.equal(brief.contract, "agent-insight-v1");
    assert.equal(brief.question, "What should I fix first this weekend?");
    assert.equal(brief.prioritizedEvidence.length <= 2, true);
    assert.ok(brief.answerRequirements.some((item) => item.includes("known facts")));
    assert.equal(brief.safety.approvalRequired, true);
    assert.equal(brief.safety.preflightRequired, true);
    assert.equal(brief.safety.directMutation, false);
    assert.ok(Array.isArray(brief.unknowns));
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
