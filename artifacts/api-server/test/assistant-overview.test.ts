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
  assert.equal(typeof parsed.activeWork.scanStatus, "string");
});

test("assistant recommendation fields preserve evidence and explicit action state", () => {
  const result = GetAssistantOverviewResponse.parse({
    summary: {
      health: "attention_required",
      attentionCount: 1,
      counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
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
    informational: [],
    activeWork: { scanStatus: "idle", acquisitionJobs: 0 },
  });
  assert.equal(result.attention[0].recommendedAction.includes("replacing"), true);
});
