import { readAcquisitionJob, listAcquisitionJobs } from "./acquisition-jobs";
import { listAcquisitionRecommendations, readAcquisitionRecommendation } from "./acquisition-intelligence";
import { listArchiveOperations } from "./archive-operations";
import { readReviewItem } from "./review-queue";
import { readJobs } from "./download-engine";

export type LineageStageStatus = "known" | "unknown" | "not_applicable";
export type LineageStage = {
  status: LineageStageStatus;
  id?: string | null;
  label?: string;
  detail?: string;
  occurredAt?: string | null;
};

export type WorkloadLineage = {
  workloadId: string;
  title: string;
  origin: LineageStage;
  review: LineageStage;
  approval: LineageStage;
  acquisition: LineageStage;
  download: LineageStage;
  verification: LineageStage;
  operation: LineageStage;
  outcome: LineageStage;
};

const unknown = (detail: string): LineageStage => ({ status: "unknown", detail });
const notApplicable = (detail: string): LineageStage => ({ status: "not_applicable", detail });

export function readWorkloadLineage(workloadId: string, ownerId: string): WorkloadLineage | null {
  const [prefix, ...parts] = workloadId.split(":");
  const rawId = parts.at(-1);
  const id = Number(rawId);
  if (!prefix || !rawId || !Number.isInteger(id)) return null;

  let title = "Work item";
  let recommendation = null as ReturnType<typeof readAcquisitionRecommendation>;
  let review = null as ReturnType<typeof readReviewItem>;
  let acquisition = null as ReturnType<typeof readAcquisitionJob>;
  let download: ReturnType<typeof readJobs>[number] | undefined;

  if (prefix === "assistant" && rawId.startsWith("download")) return null;
  if (prefix === "assistant") {
    recommendation = readAcquisitionRecommendation(id, ownerId);
    if (!recommendation) return null;
    title = recommendation.title;
    review = recommendation.reviewItemId == null ? null : readReviewItem(recommendation.reviewItemId, ownerId);
    acquisition = recommendation.acquisitionJobId == null ? null : readAcquisitionJob(recommendation.acquisitionJobId, ownerId);
  } else if (prefix === "download") {
    download = readJobs(ownerId).find((item) => item.id === id);
    if (!download) return null;
    title = download.title;
    acquisition = listAcquisitionJobs(ownerId).find((item) => item.downloadJobId === id) ?? null;
  } else if (prefix === "review") {
    review = readReviewItem(id, ownerId);
    if (!review) return null;
    title = review.title;
    const recommendations = listAcquisitionRecommendations(ownerId);
    recommendation = recommendations.find((item) => item.reviewItemId === id) ?? null;
    acquisition = recommendation?.acquisitionJobId == null ? null : readAcquisitionJob(recommendation.acquisitionJobId, ownerId);
  } else return null;

  if (!download && acquisition?.downloadJobId != null) download = readJobs(ownerId).find((item) => item.id === acquisition!.downloadJobId);
  const operations = listArchiveOperations(ownerId);
  const operation = operations.find((item) =>
    (acquisition && item.acquisitionJobId === acquisition.id) ||
    (download && item.downloadJobId === download.id) ||
    (review && item.reviewItemId === review.id),
  ) ?? null;

  const origin: LineageStage = recommendation
    ? { status: "known", id: `recommendation:${recommendation.id}`, label: "Found", detail: "This item was surfaced by archive and provider evidence.", occurredAt: recommendation.generatedAt }
    : unknown("The original recommendation is not linked to this item.");
  const reviewStage: LineageStage = review
    ? { status: "known", id: `review:${review.id}`, label: "Reviewed", detail: `Review is ${review.state}.`, occurredAt: review.decisionAt ?? review.updatedAt }
    : unknown("No linked review record is available.");
  const approval: LineageStage = review?.state === "approved"
    ? { status: "known", id: `review:${review.id}`, label: "Approved", detail: "The review contains an explicit approval.", occurredAt: review.decisionAt }
    : review?.state === "rejected" || review?.state === "deferred"
      ? { status: "known", id: `review:${review.id}`, label: review.state === "rejected" ? "Dismissed" : "Deferred", detail: "No acquisition approval is recorded.", occurredAt: review.decisionAt }
      : review ? unknown("A review exists, but approval is not recorded.") : unknown("No linked approval record is available.");
  const acquisitionStage: LineageStage = acquisition
    ? { status: "known", id: `acquisition:${acquisition.id}`, label: "Acquisition requested", detail: `Acquisition state is ${acquisition.state}.`, occurredAt: acquisition.plannedAt }
    : recommendation?.acquisitionJobId == null ? notApplicable("No acquisition job has been created.") : unknown("The linked acquisition job could not be read.");
  const downloadStage: LineageStage = download
    ? { status: "known", id: `download:${download.id}`, label: download.status === "complete" ? "Downloaded" : "Download in progress", detail: `Download state is ${download.status}.`, occurredAt: download.completedAt ?? download.startedAt ?? download.createdAt }
    : acquisition?.downloadJobId == null ? notApplicable("No download is linked yet.") : unknown("A download reference exists, but its record is unavailable.");
  const verification: LineageStage = download?.verification === "passed"
    ? { status: "known", id: `download:${download.id}`, label: "Verified", detail: "The download record contains a passed verification result.", occurredAt: download.completedAt }
    : download?.verification === "failed"
      ? { status: "known", id: `download:${download.id}`, label: "Verification failed", detail: "The download record contains a failed verification result.", occurredAt: download.completedAt }
      : download ? unknown("A download exists, but verification is not complete.") : notApplicable("Verification does not apply before a download exists.");
  const operationStage: LineageStage = operation
    ? { status: "known", id: `operation:${operation.id}`, label: operation.status === "completed" ? "Added to archive" : "Archive operation", detail: `Archive operation is ${operation.status}.`, occurredAt: operation.completedAt ?? operation.startedAt }
    : review?.state === "approved" ? unknown("Approval exists, but no linked archive operation is recorded.") : notApplicable("No approved archive operation applies.");
  const outcome: LineageStage = operation?.status === "completed"
    ? { status: "known", id: `operation:${operation.id}`, label: "Archive outcome recorded", detail: operation.postflight?.verification ? "Post-operation verification is recorded." : "The archive operation completed; final verification detail is unavailable.", occurredAt: operation.completedAt }
    : operation ? unknown("An archive operation exists, but its final outcome is not complete.") : notApplicable("No archive outcome is linked.");

  return { workloadId, title, origin, review: reviewStage, approval, acquisition: acquisitionStage, download: downloadStage, verification, operation: operationStage, outcome };
}
