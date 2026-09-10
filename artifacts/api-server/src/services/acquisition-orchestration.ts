import { archiveDb, addEvent } from "../lib/archive-db";
import {
  createAcquisitionJob,
  readAcquisitionJob,
} from "./acquisition-jobs";
import {
  linkRecommendationToAcquisitionJob,
  readAcquisitionRecommendation,
} from "./acquisition-intelligence";
import { readReviewItem } from "./review-queue";
import {
  createArchiveOperation,
  type ArchiveOperation,
} from "./archive-operations";
import { readJobs } from "./download-engine";

export async function createApprovedAcquisitionJob(reviewItemId: number, ownerId: string) {
  const review = readReviewItem(reviewItemId, ownerId);
  if (!review) throw new Error("Review item not found.");
  if (review.kind !== "acquisition_recommendation") {
    throw new Error("Only acquisition recommendation reviews can create acquisition jobs.");
  }
  if (review.state !== "approved") {
    throw new Error("The acquisition recommendation must be explicitly approved.");
  }
  const recommendationId = Number(review.payload.recommendationId);
  if (!Number.isInteger(recommendationId) || recommendationId < 1) {
    throw new Error("Review item does not reference a valid acquisition recommendation.");
  }
  const recommendation = readAcquisitionRecommendation(recommendationId, ownerId);
  if (!recommendation || recommendation.reviewItemId !== review.id) {
    throw new Error("Acquisition recommendation linkage is invalid.");
  }
  if (recommendation.acquisitionJobId) {
    const existing = readAcquisitionJob(recommendation.acquisitionJobId, ownerId);
    if (existing) return { recommendation, job: existing, created: false };
  }
  const routeProvider = typeof recommendation.route.providerId === "string"
    ? recommendation.route.providerId
    : null;
  if (!routeProvider || recommendation.route.operational !== true) {
    throw new Error("The recommended acquisition provider is unavailable.");
  }
  const job = await createAcquisitionJob({
    mediaType: recommendation.mediaType,
    title: recommendation.title,
    year: recommendation.year ?? undefined,
    externalId: recommendation.externalId ?? undefined,
    providerId: routeProvider as "sonarr" | "radarr" | "prowlarr" | "qbittorrent",
    start: true,
    archiveIdentity: recommendation.target,
    policyDecision: {
      decision: "approved",
      reviewItemId: review.id,
      decidedBy: review.decidedBy,
      decisionAt: review.decisionAt,
    },
    metadata: {
      acquisitionRecommendationId: recommendation.id,
      reviewItemId: review.id,
      destination: recommendation.destination,
      preferredQuality: recommendation.preferredQuality,
    },
  }, ownerId);
  if (!job) throw new Error("Acquisition job could not be created.");
  const linked = linkRecommendationToAcquisitionJob(recommendation.id, job.id, ownerId);
  addEvent(
    "success",
    `Approved recommendation ${recommendation.id} linked to acquisition job ${job.id}.`,
    "acquisition-orchestration",
    ownerId,
  );
  return { recommendation: linked, job, created: true };
}

export function linkAcquisitionDownload(
  acquisitionJobId: number,
  downloadJobId: number,
  ownerId: string,
) {
  const acquisition = readAcquisitionJob(acquisitionJobId, ownerId);
  if (!acquisition) throw new Error("Acquisition job not found.");
  const download = readJobs(ownerId).find((item) => item.id === downloadJobId);
  if (!download) throw new Error("Download job not found.");
  archiveDb.prepare(`
    UPDATE acquisition_job
    SET download_job_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_id = ?
  `).run(downloadJobId, acquisitionJobId, ownerId);
  addEvent(
    "info",
    `Acquisition job ${acquisitionJobId} linked to download job ${downloadJobId}.`,
    "acquisition-orchestration",
    ownerId,
  );
  return readAcquisitionJob(acquisitionJobId, ownerId)!;
}

export function planApprovedAcquisitionImport(
  acquisitionJobId: number,
  destinationPath: string,
  ownerId: string,
  dryRun = false,
): ArchiveOperation {
  const acquisition = readAcquisitionJob(acquisitionJobId, ownerId);
  if (!acquisition) throw new Error("Acquisition job not found.");
  if (!acquisition.downloadJobId) {
    throw new Error("Acquisition job is not linked to a local download.");
  }
  const download = readJobs(ownerId).find((item) => item.id === acquisition.downloadJobId);
  if (!download) throw new Error("Linked download job not found.");
  if (download.status !== "complete" || download.verification !== "passed" || !download.finalPath) {
    throw new Error("The linked download must be complete and verified before import.");
  }
  const reviewId = Number(acquisition.metadata.reviewItemId);
  const review = readReviewItem(reviewId, ownerId);
  if (!review || review.state !== "approved") {
    throw new Error("The acquisition approval is required before import.");
  }
  return createArchiveOperation({
    action: "import",
    sourceKind: "acquisition_recommendation",
    sourceId: String(acquisition.metadata.acquisitionRecommendationId ?? acquisition.id),
    sourcePath: download.finalPath,
    destinationPath,
    reviewItemId: review.id,
    acquisitionJobId: acquisition.id,
    downloadJobId: download.id,
    dryRun,
    idempotencyKey: `acquisition-import:${acquisition.id}:${destinationPath}`,
  }, ownerId);
}