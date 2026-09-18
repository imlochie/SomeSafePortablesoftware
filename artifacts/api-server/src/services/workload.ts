import { archiveDb } from "../lib/archive-db";
import { readJobs } from "./download-engine";
import type { ReviewItemState } from "./review-queue";

export const workloadStates = ["needs_you", "being_handled", "waiting", "interesting", "completed", "dismissed", "superseded", "blocked", "uncertain"] as const;
export type WorkloadState = (typeof workloadStates)[number];

export type WorkloadItem = {
  id: string;
  title: string;
  reviewItemId: number | null;
  findingClassification: string | null;
  currentObservationId: number | null;
  provider: string | null;
  refreshId: string | null;
  evidenceKey: string | null;
  observedAt: string | null;
  changeContext: {
    previousObservationId: number;
    previousEvidenceKey: string;
    previousObservedAt: string;
  } | null;
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
  completed: 0, dismissed: 0, superseded: 0, blocked: 0, uncertain: 0,
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
      reviewItemId: null, findingClassification: null, currentObservationId: null,
      provider: null, refreshId: null, evidenceKey: null, observedAt: null, changeContext: null,
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
      reviewItemId: review.id,
      findingClassification: typeof review.payload.classification === "string" ? review.payload.classification : null,
      currentObservationId: review.currentObservationId,
      provider: typeof review.payload.provider === "string"
        ? review.payload.provider
        : review.payload.snapshot && typeof review.payload.snapshot === "object" && typeof (review.payload.snapshot as { provider?: unknown }).provider === "string"
          ? String((review.payload.snapshot as { provider: string }).provider)
          : null,
      refreshId: review.payload.snapshot && typeof review.payload.snapshot === "object" && typeof (review.payload.snapshot as { refreshId?: unknown }).refreshId === "string"
        ? String((review.payload.snapshot as { refreshId: string }).refreshId)
        : null,
      evidenceKey: review.evidenceKey,
      observedAt: review.observedAt,
      changeContext: review.changeContext,
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
      reviewItemId: null, findingClassification: null, currentObservationId: null,
      provider: null, refreshId: null, evidenceKey: null, observedAt: null, changeContext: null,
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
  counts.superseded += reviewCounts.superseded;
  return { items, counts, generatedAt: new Date().toISOString() };
}

type ScanSummary = { status: string; completedAt: string | null };
function readScanSummary(ownerId: string): ScanSummary {
  const row = archiveDb.prepare("SELECT status, completed_at FROM archive_scan WHERE owner_id = ?").get(ownerId) as { status?: string; completed_at?: string | null } | undefined;
  return { status: row?.status ?? "not_scanned", completedAt: row?.completed_at ?? null };
}

type ReviewSummary = {
  id: number;
  kind: string;
  title: string;
  state: ReviewItemState;
  updatedAt: string;
  payload: Record<string, unknown>;
  currentObservationId: number | null;
  evidenceKey: string | null;
  observedAt: string | null;
  changeContext: {
    previousObservationId: number;
    previousEvidenceKey: string;
    previousObservedAt: string;
  } | null;
};

function isSupersededPayload(value: unknown) {
  try {
    const payload = JSON.parse(String(value ?? "{}")) as { lifecycleStatus?: unknown };
    return payload.lifecycleStatus === "superseded";
  } catch {
    return false;
  }
}
function readReviewCounts(ownerId: string) {
  const rows = archiveDb.prepare(`
    SELECT state, COALESCE(json_extract(payload_json, '$.lifecycleStatus'), '') AS lifecycle_status, COUNT(*) AS count
    FROM review_item WHERE owner_id = ? GROUP BY state, lifecycle_status
  `).all(ownerId) as Array<{ state: ReviewItemState; lifecycle_status: string; count: number }>;
  const count = (state: ReviewItemState) => Number(rows.filter((row) => row.state === state && row.lifecycle_status !== "superseded").reduce((total, row) => total + Number(row.count), 0));
  const superseded = rows.filter((row) => row.lifecycle_status === "superseded").reduce((total, row) => total + Number(row.count), 0);
  return { needsYou: count("pending") + count("reopened"), waiting: count("deferred"), beingHandled: count("approved"), dismissed: count("rejected"), superseded };
}

function readRecentReviews(ownerId: string): ReviewSummary[] {
  const rows = archiveDb.prepare(`
    SELECT r.id, r.kind, r.title, r.state, r.payload_json, r.updated_at,
           o.id AS current_observation_id, o.evidence_key AS current_evidence_key, o.observed_at AS current_observed_at,
           p.id AS previous_observation_id, p.evidence_key AS previous_evidence_key, p.observed_at AS previous_observed_at
    FROM review_item r
    LEFT JOIN review_item_observation o
      ON o.review_item_id = r.id AND o.owner_id = r.owner_id AND o.status = 'active'
    LEFT JOIN review_item_observation p
      ON p.review_item_id = r.id AND p.owner_id = r.owner_id AND p.status = 'superseded'
      AND p.id = (SELECT MAX(p2.id) FROM review_item_observation p2 WHERE p2.review_item_id = r.id AND p2.owner_id = r.owner_id AND p2.status = 'superseded')
    WHERE r.owner_id = ? AND r.state IN ('pending', 'reopened', 'deferred', 'approved', 'rejected')
      AND COALESCE(json_extract(r.payload_json, '$.lifecycleStatus'), '') != 'superseded'
    ORDER BY r.updated_at DESC, r.id DESC LIMIT 20
  `).all(ownerId) as Array<{
    id: number;
    kind: string;
    title: string;
    state: ReviewItemState;
    payload_json: string;
    updated_at: string;
    current_observation_id?: number | null;
    current_evidence_key?: string | null;
    current_observed_at?: string | null;
    previous_observation_id?: number | null;
    previous_evidence_key?: string | null;
    previous_observed_at?: string | null;
  }>;
  return rows
    .filter((row) => !isSupersededPayload(row.payload_json))
    .map((row) => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { /* keep empty */ }
      return {
        id: Number(row.id), kind: row.kind, title: row.title, state: row.state, updatedAt: row.updated_at,
        payload,
        currentObservationId: row.current_observation_id == null ? null : Number(row.current_observation_id),
        evidenceKey: row.current_evidence_key ?? (typeof payload.evidenceKey === "string" ? payload.evidenceKey : null),
        observedAt: row.current_observed_at ?? null,
        changeContext: row.previous_observation_id == null || !row.previous_evidence_key || !row.previous_observed_at
          ? null
          : {
            previousObservationId: Number(row.previous_observation_id),
            previousEvidenceKey: row.previous_evidence_key,
            previousObservedAt: row.previous_observed_at,
          },
      };
    });
}
