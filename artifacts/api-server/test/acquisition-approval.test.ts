import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

/**
 * Acquisition is an archive operation. Provider work spends bandwidth, reaches
 * a remote indexer or download client, and ends in a file destined for the
 * archive, so it sits behind the same approval boundary as the filesystem
 * mutation engine.
 *
 * These tests assert the refusal, not the happy path: the lifecycle itself is
 * covered in acquisition-jobs.test.ts.
 */

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  SONARR_URL: process.env.SONARR_URL,
  SONARR_API_KEY: process.env.SONARR_API_KEY,
};

let acquisition: typeof import("../src/services/acquisition-jobs");
let review: typeof import("../src/services/review-queue");

let providerCalls = 0;

before(async () => {
  process.env.SONARR_URL = "http://acquisition-approval.test";
  process.env.SONARR_API_KEY = "test-sonarr-key";
  acquisition = await import("../src/services/acquisition-jobs");
  review = await import("../src/services/review-queue");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    providerCalls += 1;
    const url = new URL(String(input));
    if (url.pathname.endsWith("/system/status")) {
      return new Response(JSON.stringify({ version: "4.0.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: 900, status: "started" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
    else process.env[key as keyof NodeJS.ProcessEnv] = value;
  }
});

function reviewItem(ownerId: string, subjectKey: string) {
  return review.ensureReviewItem(ownerId, {
    kind: "acquisition_recommendation",
    subjectKey,
    title: `Acquisition review for ${subjectKey}`,
  });
}

function request(ownerId: string, metadata: Record<string, unknown>) {
  return acquisition.createAcquisitionJob({
    mediaType: "series",
    title: "Guarded Series",
    externalId: "500",
    providerId: "sonarr",
    metadata,
    start: true,
  }, ownerId);
}

describe("acquisition approval boundary", { concurrency: false }, () => {
  test("refuses provider work when no review item is referenced", async () => {
    const before = providerCalls;
    await assert.rejects(
      () => request("approval-owner-none", { requestReason: "operator" }),
      /requires an approved review item/i,
    );
    assert.equal(providerCalls, before, "no provider request may be sent");
  });

  test("refuses provider work while the review item is still pending", async () => {
    const ownerId = "approval-owner-pending";
    const item = reviewItem(ownerId, "pending-500");
    await assert.rejects(
      () => request(ownerId, { reviewItemId: item.id }),
      /is pending\. Provider work requires an approved review item/i,
    );
  });

  test("refuses provider work when the review item was rejected", async () => {
    const ownerId = "approval-owner-rejected";
    const item = reviewItem(ownerId, "rejected-500");
    review.rejectReviewItem(item.id, ownerId, "Not wanted.");
    await assert.rejects(
      () => request(ownerId, { reviewItemId: item.id }),
      /is rejected/i,
    );
  });

  test("refuses provider work when the approval belongs to another owner", async () => {
    const item = reviewItem("approval-owner-a", "cross-owner-500");
    review.approveReviewItem(item.id, "approval-owner-a", "Approved.");
    await assert.rejects(
      () => request("approval-owner-b", { reviewItemId: item.id }),
      /could not be found for this owner/i,
    );
  });

  test("refuses provider work when the review item is the wrong kind", async () => {
    const ownerId = "approval-owner-wrong-kind";
    const item = review.ensureReviewItem(ownerId, {
      kind: "naming_proposal",
      subjectKey: "wrong-kind-500",
      title: "A naming proposal is not an acquisition approval",
    });
    review.approveReviewItem(item.id, ownerId, "Approved a rename, not an acquisition.");
    await assert.rejects(
      () => request(ownerId, { reviewItemId: item.id }),
      /requires an acquisition recommendation review/i,
    );
  });

  test("leaves the job planned so a refusal is not replayed as a retry", async () => {
    const ownerId = "approval-owner-planned";
    const item = reviewItem(ownerId, "planned-500");
    await assert.rejects(() => request(ownerId, { reviewItemId: item.id }));
    const jobs = acquisition.listAcquisitionJobs(ownerId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.state, "planned", "a refusal is not a provider failure");
    assert.equal(jobs[0]?.providerJobId, null);
    assert.equal(jobs[0]?.errorCode, null);
  });

  test("accepts an approval carried in the policy decision", async () => {
    const ownerId = "approval-owner-policy";
    const item = reviewItem(ownerId, "policy-500");
    review.approveReviewItem(item.id, ownerId, "Approved.");
    const job = await acquisition.createAcquisitionJob({
      mediaType: "series",
      title: "Policy Approved Series",
      externalId: "501",
      providerId: "sonarr",
      policyDecision: { decision: "approved", reviewItemId: item.id },
      start: true,
    }, ownerId);
    assert.equal(job?.state, "searching");
    // refreshActiveAcquisitionJobs sweeps every owner, so this file must not
    // leave an active job behind for other suites to count.
    acquisition.cancelAcquisitionJob(job!.id, ownerId);
  });

  test("allows planning without provider work while the review is pending", async () => {
    const ownerId = "approval-owner-plan-only";
    const item = reviewItem(ownerId, "plan-only-500");
    const before = providerCalls;
    const job = await acquisition.createAcquisitionJob({
      mediaType: "series",
      title: "Planned Series",
      externalId: "502",
      providerId: "sonarr",
      metadata: { reviewItemId: item.id },
      start: false,
    }, ownerId);
    assert.equal(job?.state, "planned");
    assert.equal(providerCalls, before, "planning must not contact the provider");
  });

  test("refuses to retry into provider work after an approval is withdrawn", async () => {
    const ownerId = "approval-owner-withdrawn";
    const item = reviewItem(ownerId, "withdrawn-500");
    review.approveReviewItem(item.id, ownerId, "Approved.");
    const job = await acquisition.createAcquisitionJob({
      mediaType: "series",
      title: "Withdrawn Series",
      externalId: "503",
      providerId: "sonarr",
      metadata: { reviewItemId: item.id },
      start: true,
    }, ownerId);
    assert.equal(job?.state, "searching");

    const cancelled = acquisition.cancelAcquisitionJob(job!.id, ownerId);
    assert.equal(cancelled.state, "cancelled");

    // Withdrawing the approval must block the retry path too, not just creation.
    review.reopenReviewItem(item.id, ownerId, "Withdrawn pending a second look.");
    await assert.rejects(
      () => acquisition.retryAcquisitionJob(job!.id, ownerId),
      /requires an approved review item/i,
    );
  });
});
