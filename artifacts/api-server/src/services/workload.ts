import { readAssistantOverview } from "./assistant-overview";
import { readJobs } from "./download-engine";
import { listReviewItems } from "./review-queue";
import { readArchiveHealth } from "./archive-health";

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
  const [overview, jobs, health] = await Promise.all([readAssistantOverview(ownerId), Promise.resolve(readJobs(ownerId)), readArchiveHealth(ownerId)]);
  const items: WorkloadItem[] = [];

  for (const item of overview.recommendations) {
    const state: WorkloadState = item.state === "blocked" ? "blocked" : item.state === "uncertain" ? "uncertain" : item.state === "actionable" ? "needs_you" : "interesting";
    items.push({
      id: `assistant:${item.id}`,
      title: item.title.replace(/^Download /, ""),
      summary: item.explanation,
      state,
      needsUserAction: state === "needs_you",
      nextStep: state === "needs_you" ? item.recommendedAction : state === "blocked" ? "Resolve the dependency before continuing." : "Review the explanation when you are ready.",
      destination: "assistant",
      source: "assistant",
      sourceId: item.id,
      evidence: item.evidence,
      confidence: item.confidence,
      lastConfirmedAt: null,
      freshness: 'unknown',
    });
  }

  for (const job of jobs) {
    const terminal = job.status === "complete" || job.status === "failed" || job.status === "cancelled";
    const state: WorkloadState = job.status === "complete" ? "completed"
      : job.status === "failed" || job.status === "recovery_required" ? "blocked"
      : job.status === "queued" || job.status === "paused" ? "waiting"
      : "being_handled";
    items.push({
      id: `download:${job.id}`,
      title: job.title,
      summary: job.status === "complete" ? "The file was downloaded and verified." : job.errorMessage ?? `The system is ${job.currentPhase ?? job.status}.`,
      state,
      needsUserAction: job.status === "recovery_required" || job.status === "failed",
      nextStep: job.status === "complete" ? "Find the outcome in History." : job.status === "failed" ? "Review the result before trying again." : job.status === "queued" ? "Start the job when you are ready." : job.status === "paused" ? "Resume the job when you are ready." : "The system will continue and verify the result.",
      destination: terminal ? "history" : "queue",
      source: "download",
      sourceId: String(job.id),
      evidence: [job.currentPhase ?? job.status, ...(job.errorMessage ? [job.errorMessage] : [])],
      confidence: job.verification === "passed" ? "high" : null,
      lastConfirmedAt: job.updatedAt,
      freshness: freshnessOf(job.updatedAt),
    });
  }

  for (const finding of health.findings) {
    const state: WorkloadState = finding.state === "needs_you" ? "needs_you" : finding.state === "uncertain" ? "uncertain" : finding.state === "blocked" ? "blocked" : finding.state === "waiting" ? "waiting" : finding.state === "resolved" ? "completed" : "interesting";
    items.push({ id: `health:${finding.id}`, title: finding.title, summary: finding.summary, state, needsUserAction: state === "needs_you", nextStep: finding.recommendedAction === "review" ? "Review the evidence before deciding." : finding.recommendedAction === "investigate" ? "Investigate what is known and what is missing." : "Wait for more information.", destination: state === "needs_you" ? "assistant" : "history", source: "health", sourceId: finding.sourceId, evidence: finding.known, confidence: finding.confidence === null ? null : `${Math.round(finding.confidence * 100)}%`, lastConfirmedAt: health.generatedAt, freshness: "fresh" });
  }

  for (const review of listReviewItems(ownerId)) {
    const state: WorkloadState = review.state === "rejected" ? "dismissed"
      : review.state === "deferred" ? "waiting"
      : review.state === "approved" ? "being_handled"
      : "needs_you";
    items.push({
      id: `review:${review.id}`,
      title: review.title,
      summary: state === "dismissed" ? "This was dismissed and is no longer active." : "The system is waiting for your decision.",
      state,
      needsUserAction: state === "needs_you",
      nextStep: state === "needs_you" ? "Review the explanation before deciding." : state === "waiting" ? "Reopen it when you want to continue." : "See the related outcome.",
      destination: state === "needs_you" ? "assistant" : "history",
      source: "review",
      sourceId: String(review.id),
      evidence: [review.kind, review.state],
      confidence: null,
      lastConfirmedAt: review.updatedAt,
      freshness: freshnessOf(review.updatedAt),
    });
  }

  const counts = emptyCounts();
  for (const item of items) counts[item.state] += 1;
  return { items, counts, generatedAt: new Date().toISOString() };
}
