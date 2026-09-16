import assert from "node:assert/strict";
import test from "node:test";
import { GetAssistantOverviewResponse } from "@workspace/api-zod";

test("unified workload is read-only, owner-scoped, and classifies operational truth", async () => {
  const { readWorkload } = await import("../src/services/workload");
  const report = await readWorkload("__local__");
  assert.deepEqual(Object.keys(report.counts).sort(), ["being_handled", "blocked", "completed", "dismissed", "interesting", "needs_you", "uncertain", "waiting"]);
  assert.ok(Array.isArray(report.items));
  assert.equal(typeof report.generatedAt, "string");
  for (const item of report.items) {
    assert.equal(item.id.includes(":"), true);
    assert.equal(["assistant", "download", "review", "health"].includes(item.source), true);
    assert.equal(["assistant", "queue", "history"].includes(item.destination), true);
    assert.equal(["fresh", "recent", "stale", "unknown"].includes(item.freshness), true);
    assert.equal(typeof item.lastConfirmedAt === "string" || item.lastConfirmedAt === null, true);
  }
});

test("ordering analysis proposes reversal only from explicit episode and publication metadata", async () => {
  const { analyzeOrdering } = await import("../src/services/ordering-analysis");
  const result = analyzeOrdering("Creator Season 1", [
    { id: "1", filename: "001 Latest.mp4", currentEpisode: 1, publishedAt: "2024-03-01T00:00:00Z", sourceOrder: 1 },
    { id: "2", filename: "002 Oldest.mp4", currentEpisode: 2, publishedAt: "2024-01-01T00:00:00Z", sourceOrder: 2 },
  ]);
  assert.equal(result.proposal, "reverse_episode_numbers");
  assert.equal(result.changes[0].proposedEpisode, 2);
  const unknown = analyzeOrdering("Unknown", [{ id: "1", filename: "001.mp4", currentEpisode: 1, publishedAt: null, sourceOrder: 1 }]);
  assert.equal(unknown.proposal, "no_action");
});

test("collision-safe rename planning breaks swaps without overwriting destinations", async () => {
  const { buildCollisionSafeRenamePlan } = await import("../src/services/rename-plan");
  const plan = buildCollisionSafeRenamePlan([
    { id: "a", sourcePath: "/season/A.mp4", destinationPath: "/season/B.mp4" },
    { id: "b", sourcePath: "/season/B.mp4", destinationPath: "/season/A.mp4" },
  ]);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.steps.length, 4);
  assert.equal(plan.steps.filter((step) => step.temporary).length, 2);
  const blocked = buildCollisionSafeRenamePlan([{ id: "a", sourcePath: "/season/A.mp4", destinationPath: "/season/B.mp4" }], ["/season/B.mp4"]);
  assert.equal(blocked.steps.length, 0);
  assert.equal(blocked.errors.length, 1);
});

test("ordering proposals preserve an immutable reviewed mapping and reject stale identity", async () => {
  const { createOrderingProposalSnapshot, validateOrderingProposal } = await import("../src/services/ordering-proposals");
  const input = {
    collectionId: "creator-season-1",
    hypothesis: "chronological_descending",
    confidence: "high",
    evidence: ["explicit publication dates"],
    unknowns: [],
    expectedCollectionMembership: ["/tmp/A.mp4", "/tmp/B.mp4"],
    expectedSourceState: {},
    expectedDestinationState: {},
    sourceMappings: [{ mappingId: "a", originalPath: "/tmp/A.mp4", proposedPath: "/tmp/B.mp4", currentEpisode: 1, proposedEpisode: 2, expectedSourceIdentity: "file-record-a" }],
  } as const;
  const first = createOrderingProposalSnapshot("proposal-owner", input);
  const second = createOrderingProposalSnapshot("proposal-owner", input);
  assert.equal(second.snapshot.proposalVersion, first.snapshot.proposalVersion);
  assert.equal(second.snapshot.reviewItemId, first.snapshot.reviewItemId);
  const stale = validateOrderingProposal("proposal-owner", first.snapshot.proposalId, {
    membership: ["/tmp/A.mp4", "/tmp/B.mp4"],
    sourceIdentities: { "/tmp/A.mp4": "changed-source" },
    destinations: [],
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "STALE_PROPOSAL");
});

test("lineage never links by title or timestamp and remains owner-scoped", async () => {
  const { readWorkloadLineage } = await import("../src/services/lineage");
  assert.equal(readWorkloadLineage("assistant:999999", "__local__"), null);
  assert.equal(readWorkloadLineage("download:999999", "another-owner"), null);
  assert.equal(readWorkloadLineage("not-a-domain-id", "__local__"), null);
});

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

test("discovery sections keep trending unavailable and prefer watched evidence for suggestions", async () => {
  const { buildDiscoverySections } = await import("../src/services/assistant-overview");
  const result = buildDiscoverySections({ items: [
    { key: "plex:next", title: "Next", provider: "plex", itemType: "episode", year: null, releaseDate: null, durationMinutes: 40, status: "unwatched", progressPercent: 0, playCount: 0, lastWatchedAt: null, watchedMinutes: 0, seriesTitle: "Active", seasonNumber: 1, episodeNumber: 2, seriesProgress: 50, isNextEpisode: true, evidence: ["watch history"] },
    { key: "plex:recent", title: "Recent", provider: "plex", itemType: "movie", year: 2026, releaseDate: "2026-09-10T00:00:00.000Z", durationMinutes: 100, status: "unwatched", progressPercent: 0, playCount: 0, lastWatchedAt: null, watchedMinutes: 0, seriesTitle: null, seasonNumber: null, episodeNumber: null, seriesProgress: null, isNextEpisode: false, evidence: ["release metadata"] },
    { key: "plex:repeat", title: "Repeat", provider: "plex", itemType: "movie", year: 2020, releaseDate: null, durationMinutes: 100, status: "completed", progressPercent: 100, playCount: 3, lastWatchedAt: "2026-08-01T00:00:00.000Z", watchedMinutes: 300, seriesTitle: null, seasonNumber: null, episodeNumber: null, seriesProgress: null, isNextEpisode: false, evidence: ["view count"] },
  ], summary: {} } as any, new Date("2026-09-15T00:00:00.000Z"));
  assert.equal(result.trending.status, "not_available");
  assert.equal(result.recentlyReleased.items[0].title, "Recent");
  assert.equal(result.suggestedForYou.items[0].title, "Next");
  assert.ok(result.suggestedForYou.items[0].reasons.includes("next unwatched episode in a known series"));
});

test("personalized briefing ranks availability, archive priority, affinity, and then title", async () => {
  const { rankPersonalizedBriefing } = await import("../src/services/assistant-overview");
  const base = (id: string, title: string, priority: "high" | "medium", affinity: "high" | "unknown", state: "actionable" | "blocked") => ({
    id, type: "download" as const, priority, confidence: "high", title,
    explanation: state === "blocked" ? "No usable source is currently available." : "Ready to acquire.",
    evidence: [], recommendedAction: "Review acquisition", state, reviewItemId: null,
    personalAffinity: { priority: affinity, basedOn: affinity === "high" ? ["currently in progress"] : ["No matching provider viewing evidence."] },
  });
  const result = rankPersonalizedBriefing([
    base("blocked", "The Wire", "high", "high", "blocked"),
    base("unknown", "Random Show", "high", "unknown", "actionable"),
    base("personal", "The Bear", "high", "high", "actionable"),
    base("medium", "Interstellar", "medium", "high", "actionable"),
  ]);
  assert.deepEqual(result.map((item) => item.title), ["The Bear", "Random Show", "Interstellar", "The Wire"]);
  assert.equal(result[0].personalAffinity, "high");
  assert.equal(result[3].availability, "blocked");
  assert.equal(result[3].blockedReason, "No usable source is currently available.");
});

test("watch-history evidence outranks downloaded-only evidence", async () => {
  const { rankPersonalizedBriefing } = await import("../src/services/assistant-overview");
  const recommendation = (id: string, title: string, personalPriority: "high" | "unknown", basedOn: string[]) => ({
    id, type: "download" as const, priority: "high" as const, confidence: "high", title,
    explanation: "Archive evidence is present.", evidence: ["downloaded/archive evidence"],
    recommendedAction: "Review acquisition", state: "actionable" as const, reviewItemId: null,
    personalAffinity: { priority: personalPriority, basedOn },
  });
  const result = rankPersonalizedBriefing([
    recommendation("archive-only", "Show A", "unknown", ["No matching provider viewing evidence."]),
    recommendation("watched", "Show B", "high", ["viewed within the last 30 days"]),
  ]);
  assert.deepEqual(result.map((item) => item.title), ["Show B", "Show A"]);
  assert.equal(result[0].reasons.includes("viewed within the last 30 days"), true);
  assert.equal(result[1].personalAffinity, "unknown");
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
    discovery: {
      upcoming: { status: "limited", reason: "none", items: [] },
      recentlyReleased: { status: "limited", reason: "none", items: [] },
      trending: { status: "not_available", reason: "no_supported_trending_source", items: [] },
      suggestedForYou: { status: "limited", reason: "none", items: [] },
    },
    personalizedBriefing: [],
    mediaExperience: {
      sourceStatus: "no_synced_provider_data",
      items: [],
      completed: [],
      inProgress: [],
      summary: { completedCount: 0, inProgressCount: 0, watchedMinutes: 0, watchedHours: 0 },
      currentViewingMomentum: { activeSeriesCount: 0, recentlyWatchedCount: 0, windowDays: 30 },
      watchlist: { status: "not_available", items: [] },
    },
  });
  assert.equal(result.attention[0].recommendedAction.includes("replacing"), true);
});
