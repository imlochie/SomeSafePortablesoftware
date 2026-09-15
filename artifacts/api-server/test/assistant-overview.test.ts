import assert from "node:assert/strict";
import test from "node:test";
import { GetAssistantOverviewResponse } from "@workspace/api-zod";

test("assistant overview is deterministic, typed, and safe when the archive is empty", async () => {
  const { readAssistantOverview } = await import("../src/services/assistant-overview");
  const report = await readAssistantOverview("__local__");
  const parsed = GetAssistantOverviewResponse.parse(report);

  assert.ok(["healthy", "mostly_healthy", "attention_required"].includes(parsed.summary.health));
  assert.equal(parsed.summary.attentionCount, parsed.attention.length);
  assert.ok(Array.isArray(parsed.recommendations));
  assert.ok(Array.isArray(parsed.groups));
  assert.equal(typeof parsed.activeWork.scanStatus, "string");
});

test("assistant groups preserve item IDs and order related recommendations deterministically", async () => {
  const { groupRecommendations } = await import("../src/services/assistant-overview");
  const groups = groupRecommendations([
    {
      id: "download:2", type: "download", priority: "high", confidence: "high",
      title: "Download The Bear", explanation: "gap", evidence: ["episode missing"],
      recommendedAction: "Review acquisition", state: "actionable", reviewItemId: 22,
    },
    {
      id: "download:1", type: "download", priority: "high", confidence: "high",
      title: "Download The Bear", explanation: "gap", evidence: ["season incomplete"],
      recommendedAction: "Review acquisition", state: "actionable", reviewItemId: 21,
    },
    {
      id: "integrity:9", type: "integrity", priority: "high", confidence: "high",
      title: "The Bear file may be corrupt", explanation: "inspection failed", evidence: ["ffprobe"],
      recommendedAction: "Compare another copy", state: "actionable", reviewItemId: null,
    },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].itemCount, 2);
  assert.deepEqual(groups[0].underlyingItemIds, [21, 22]);
  assert.equal(groups[1].type, "integrity");
});

test("assistant recommendation fields preserve evidence and explicit action state", () => {
  const result = GetAssistantOverviewResponse.parse({
    summary: {
      health: "attention_required",
      attentionCount: 1,
      counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      blockedCount: 0,
      uncertainCount: 0,
      lastScan: null,
      freshness: "known",
    },
    attention: [{
      id: "integrity:1",
      type: "integrity",
      priority: "high",
      confidence: "high",
      title: "Episode may be corrupt",
      explanation: "Container inspection failed.",
      evidence: ["corrupt_or_malformed_container"],
      recommendedAction: "Compare with another copy before replacing it.",
      state: "pending",
      reviewItemId: null,
    }],
    recommendations: [],
    groups: [],
    blocked: [],
    uncertain: [],
    informational: [],
    activeWork: { scanStatus: "idle", acquisitionJobs: 0 },
  });
  assert.equal(result.attention[0].recommendedAction.includes("replacing"), true);
});
