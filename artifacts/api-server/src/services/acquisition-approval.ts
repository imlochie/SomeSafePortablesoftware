import { readReviewItem, type ReviewItem } from "./review-queue";

/**
 * Acquisition is an archive operation, not a side door around the operation
 * model. Starting provider work spends bandwidth, touches a remote indexer or
 * client, and ends in a file that will be imported into the archive, so it
 * requires the same approval the filesystem mutation engine requires.
 *
 * This module is the single place that decides whether a job may contact a
 * provider. It deliberately depends only on the review queue so that
 * `acquisition-jobs.ts` can enforce the boundary without importing
 * `acquisition-orchestration.ts`, which imports `acquisition-jobs.ts` in turn.
 */

export interface AcquisitionApprovalSubject {
  id: number;
  metadata: Record<string, unknown>;
  request: Record<string, unknown>;
}

function candidateReviewItemId(subject: AcquisitionApprovalSubject): number | null {
  const policyDecision = subject.metadata.policyDecision;
  const sources: Array<unknown> = [
    subject.metadata.reviewItemId,
    policyDecision && typeof policyDecision === "object"
      ? (policyDecision as Record<string, unknown>).reviewItemId
      : undefined,
  ];
  for (const value of sources) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

/**
 * Resolves the approved review item authorizing provider work for this job, or
 * throws. Callers must invoke this before the first provider transition.
 */
export function assertAcquisitionApproval(
  subject: AcquisitionApprovalSubject,
  ownerId: string,
): ReviewItem {
  const reviewItemId = candidateReviewItemId(subject);
  if (reviewItemId === null) {
    throw new Error(
      "Acquisition provider work requires an approved review item. "
        + "Create the request through an acquisition recommendation review instead of starting it directly.",
    );
  }
  const review = readReviewItem(reviewItemId, ownerId);
  if (!review) {
    throw new Error("The acquisition review item could not be found for this owner.");
  }
  if (review.kind !== "acquisition_recommendation") {
    throw new Error(
      `Acquisition provider work requires an acquisition recommendation review, not a ${review.kind} review.`,
    );
  }
  if (review.state !== "approved") {
    throw new Error(
      `The acquisition review item is ${review.state}. Provider work requires an approved review item.`,
    );
  }
  return review;
}
