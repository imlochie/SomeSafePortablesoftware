import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, test } from "node:test";

let review: typeof import("../src/services/review-queue");
let operations: typeof import("../src/services/archive-operations");
let writeSettings: typeof import("../src/lib/archive-db").writeSettings;
let root = "";

before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "archive-control-plane-"));
  ({ writeSettings } = await import("../src/lib/archive-db"));
  review = await import("../src/services/review-queue");
  operations = await import("../src/services/archive-operations");
  writeSettings({
    dataDirectory: root,
    downloadDirectory: root,
    temporaryDirectory: root,
    archiveDirectory: root,
  });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("generic review queue", { concurrency: false }, () => {
  test("is idempotent, owner-scoped, and records valid decision transitions", () => {
    const first = review.ensureReviewItem("review-owner", {
      kind: "naming_proposal",
      subjectKey: "name:1:evidence",
      title: "Rename Example",
      payload: { sourcePath: "before.mkv", destinationPath: "after.mkv" },
    });
    const repeated = review.ensureReviewItem("review-owner", {
      kind: "naming_proposal",
      subjectKey: "name:1:evidence",
      title: "Rename Example",
      payload: { sourcePath: "before.mkv", destinationPath: "after.mkv" },
    });
    assert.equal(repeated.id, first.id);
    assert.equal(review.readReviewItem(first.id, "other-owner"), null);

    const approved = review.approveReviewItem(first.id, "review-owner", "Checked metadata.");
    assert.equal(approved.state, "approved");
    assert.equal(approved.decisions.length, 1);
    assert.throws(
      () => review.rejectReviewItem(first.id, "review-owner"),
      /Cannot move/,
    );
    const reopened = review.reopenReviewItem(first.id, "review-owner", "Evidence changed.");
    assert.equal(reopened.state, "reopened");
    assert.equal(reopened.decisions.length, 2);
    assert.equal(review.deferReviewItem(first.id, "review-owner").state, "deferred");
  });
});

describe("approved archive operations", { concurrency: false }, () => {
  test("requires approval and supports idempotent preflight, import, collision safety, and rollback", async () => {
    const source = join(root, "verified-source.mkv");
    const destination = join(root, "library-copy.mkv");
    await fs.writeFile(source, "verified-media");
    const pending = review.ensureReviewItem("operation-owner", {
      kind: "operation_approval",
      subjectKey: "import:verified-source",
      title: "Import verified source",
      payload: { sourcePath: source, destinationPath: destination },
    });
    assert.throws(
      () => operations.createArchiveOperation({
        action: "import",
        sourceKind: "download",
        sourcePath: source,
        destinationPath: destination,
        reviewItemId: pending.id,
      }, "operation-owner"),
      /explicitly approved/,
    );
    review.approveReviewItem(pending.id, "operation-owner");
    const planned = operations.createArchiveOperation({
      action: "import",
      sourceKind: "download",
      sourcePath: source,
      destinationPath: destination,
      reviewItemId: pending.id,
      idempotencyKey: "verified-import",
    }, "operation-owner");
    assert.equal(
      operations.createArchiveOperation({
        action: "import",
        sourceKind: "download",
        sourcePath: source,
        destinationPath: destination,
        reviewItemId: pending.id,
        idempotencyKey: "verified-import",
      }, "operation-owner").id,
      planned.id,
    );
    const dependencies = {
      stat: (path: string) => fs.stat(path),
      access: (path: string, mode?: number) => fs.access(path, mode),
      copyFile: (from: string, to: string, mode?: number) => fs.copyFile(from, to, mode),
      rename: (from: string, to: string) => fs.rename(from, to),
      unlink: (path: string) => fs.unlink(path),
      inspect: async () => ({ verified: true, container: "matroska" }),
    };
    const ready = await operations.preflightArchiveOperation(planned.id, "operation-owner", dependencies);
    assert.equal(ready.status, "ready");
    assert.equal(await fs.readFile(source, "utf8"), "verified-media");

    const completed = await operations.executeArchiveOperation(
      planned.id,
      "operation-owner",
      true,
      dependencies,
    );
    assert.equal(completed.status, "completed");
    assert.equal(await fs.readFile(destination, "utf8"), "verified-media");
    assert.equal(await fs.readFile(source, "utf8"), "verified-media");

    const rolledBack = await operations.rollbackArchiveOperation(
      planned.id,
      "operation-owner",
      true,
      dependencies,
    );
    assert.equal(rolledBack.status, "rolled_back");
    await assert.rejects(fs.stat(destination));
    assert.equal(operations.readArchiveOperation(planned.id, "another-owner"), null);

    await fs.writeFile(destination, "collision");
    const secondReview = review.ensureReviewItem("operation-owner", {
      kind: "operation_approval",
      subjectKey: "import:collision",
      title: "Collision import",
    });
    review.approveReviewItem(secondReview.id, "operation-owner");
    const collision = operations.createArchiveOperation({
      action: "import",
      sourceKind: "download",
      sourcePath: source,
      destinationPath: destination,
      reviewItemId: secondReview.id,
    }, "operation-owner");
    const failed = await operations.preflightArchiveOperation(collision.id, "operation-owner", dependencies);
    assert.equal(failed.status, "failed");
    assert.match(failed.errorMessage ?? "", /collision/i);
  });
});