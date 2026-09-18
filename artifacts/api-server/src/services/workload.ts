import { archiveDb } from "../lib/archive-db";
import { readJobs } from "./download-engine";
import type { ReviewItemState } from "./review-queue";

export const workloadStates = ["needs_you", "being_handled", "waiting", "interesting", "completed", "dismissed", "blocked", "uncertain"] as const;
export type WorkloadState = (typeof workloadStates)[number];

export type WorkloadItem = {
  id: string;
  title: string;
  summary: string;
  state: WorkloadState;
  needsUserAction: boolean;
  nextStep: string;
  destination: "assistant" | "queue" | "history";
  source: "assistant" | "download" | "review" | "health";
  sourceId: string;
  evidence: string[];
  confidence: string | null;
  lastConfirmedAt: string | null;
  freshness: "fresh" | "recent" | "stale" | "unknown";
};

export type Workload = {
  items: WorkloadItem[];
  counts: Record<WorkloadState, number>;
  generatedAt: string;
};

function freshnessOf(value: string | null | undefined): WorkloadItem['freshness'] {
  if (!value) return 'unknown';
  const ageMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'unknown';
  if (ageMs <= 60_000) return 'fresh';
  if (ageMs <= 5 * 60_000) return 'recent';
  return 'stale';
}

const emptyCounts = (): Record<WorkloadState, number> => ({
  needs_you: 0, being_handled: 0, waiting: 0, interesting: 0,
  completed: 0, dismissed: 0, blocked: 0, uncertain: 0,
});

export async function readWorkload(ownerId: string): Promise<Workload> {
  // Home only needs a bounded operational summary. Deep naming, identity, archive
  // health, and assistant analysis belong to their dedicated surfaces; running
  // them here made startup scale with every file in the archive.
  const [jobs, scan, reviewCounts, recentReviews] = await Promise.all([
    Promise.resolve(readJobs(ownerId)),
    Promise.resolve(readScanSummary(ownerId)),
    Promise.resolve(readReviewCounts(ownerId)),
    Promise.resolve(readRecentReviews(ownerId)),
  ]);
  const items: WorkloadItem[] = [];

  for (const job of jobs) {
    const terminal = job.status === "complete" || job.status === "failed" || job.status === "cancelled";
    const state: WorkloadState = job.status === "complete" ? "completed"
      : job.status === "failed" || job.status === "recovery_required" ? "blocked"
      : job.status === "queued" || job.status === "paused" ? "waiting"
      : "being_handled";
    items.push({
      id: `download:${job.id}`, title: job.title,
      summary: job.status === "complete" ? "The file was downloaded and verified." : job.errorMessage ?? `The system is ${job.currentPhase ?? job.status}.`,
      state, needsUserAction: job.status === "recovery_required" || job.status === "failed",
      nextStep: job.status === "complete" ? "Find the outcome in History." : job.status === "failed" ? "Review the result before trying again." : job.status === "queued" ? "Start the job when you are ready." : job.status === "paused" ? "Resume the job when you are ready." : "The system will continue and verify the result.",
      destination: terminal ? "history" : "queue", source: "download", sourceId: String(job.id),
      evidence: [job.currentPhase ?? job.status, ...(job.errorMessage ? [job.errorMessage] : [])],
      confidence: job.verification === "passed" ? "high" : null, lastConfirmedAt: job.updatedAt, freshness: freshnessOf(job.updatedAt),
    });
  }

  for (const review of recentReviews) {
    const state: WorkloadState = review.state === "rejected" ? "dismissed"
      : review.state === "deferred" ? "waiting" : review.state === "approved" ? "being_handled" : "needs_you";
    items.push({
      id: `review:${review.id}`, title: review.title,
      summary: state === "dismissed" ? "This was dismissed and is no longer active." : "The system is waiting for your decision.",
      state, needsUserAction: state === "needs_you",
      nextStep: state === "needs_you" ? "Review the explanation before deciding." : state === "waiting" ? "Reopen it when you want to continue." : "See the related outcome.",
      destination: state === "needs_you" ? "assistant" : "history", source: "review", sourceId: String(review.id),
      evidence: [review.kind, review.state], confidence: null, lastConfirmedAt: review.updatedAt, freshness: freshnessOf(review.updatedAt),
    });
  }

  if (scan.status === "scanning" || scan.status === "interrupted") {
    items.push({
      id: "health:archive-scan", title: scan.status === "scanning" ? "An archive scan is running" : "An archive scan needs attention",
      summary: scan.status === "scanning" ? "The current scan state is being tracked." : "The previous scan was interrupted; review it before starting another.",
      state: scan.status === "scanning" ? "being_handled" : "needs_you", needsUserAction: scan.status === "interrupted",
      nextStep: scan.status === "scanning" ? "Wait for the scan to finish." : "Review the scan state before continuing.",
      destination: "assistant", source: "health", sourceId: "archive-scan", evidence: [scan.status], confidence: null,
      lastConfirmedAt: scan.completedAt, freshness: "fresh",
    });
  }

  const counts = emptyCounts();
  for (const item of items) counts[item.state] += 1;
  // SQL aggregates account for all review rows without materializing 42k rows.
  counts.needs_you += reviewCounts.needsYou - recentReviews.filter((item) => item.state === "pending" || item.state === "reopened").length;
  counts.waiting += reviewCounts.waiting - recentReviews.filter((item) => item.state === "deferred").length;
  counts.being_handled += reviewCounts.beingHandled - recentReviews.filter((item) => item.state === "approved").length;
  counts.dismissed += reviewCounts.dismissed - recentReviews.filter((item) => item.state === "rejected").length;
  return { items, counts, generatedAt: new Date().toISOString() };
}

type ScanSummary = { status: string; completedAt: string | null };
function readScanSummary(ownerId: string): ScanSummary {
  const row = archiveDb.prepare("SELECT status, completed_at FROM archive_scan WHERE owner_id = ?").get(ownerId) as { status?: string; completed_at?: string | null } | undefined;
  return { status: row?.status ?? "not_scanned", completedAt: row?.completed_at ?? null };
}

type ReviewSummary = { id: number; kind: string; title: string; state: ReviewItemState; updatedAt: string };

function isSupersededPayload(value: unknown) {
  try {
    const payload = JSON.parse(String(value ?? "{}")) as { lifecycleStatus?: unknown };
    return payload.lifecycleStatus === "superseded";
  } catch {
    return false;
  }
}
function readReviewCounts(ownerId: string) {
  const rows = archiveDb.prepare("SELECT state, COUNT(*) AS count FROM review_item WHERE owner_id = ? GROUP BY state").all(ownerId) as Array<{ state: ReviewItemState; count: number }>;
  const count = (state: ReviewItemState) => Number(rows.find((row) => row.state === state)?.count ?? 0);
  return { needsYou: count("pending") + count("reopened"), waiting: count("deferred"), beingHandled: count("approved"), dismissed: count("rejected") };
}

function readRecentReviews(ownerId: string): ReviewSummary[] {
  const rows = archiveDb.prepare(`
    SELECT id, kind, title, state, payload_json, updated_at
    FROM review_item
    WHERE owner_id = ? AND state IN ('pending', 'reopened', 'deferred', 'approved', 'rejected')
    ORDER BY updated_at DESC, id DESC LIMIT 20
  `).all(ownerId) as Array<{ id: number; kind: string; title: string; state: ReviewItemState; payload_json: string; updated_at: string }>;
  return rows
    .filter((row) => !isSupersededPayload(row.payload_json))
    .map((row) => ({ id: Number(row.id), kind: row.kind, title: row.title, state: row.state, updatedAt: row.updated_at }));
}
