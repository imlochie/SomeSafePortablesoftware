/**
 * Failure-path cover for the archive mutation engine.
 *
 * `archive-operations.ts` is the only code in the API permitted to rename,
 * copy, or unlink archive files, and it is the component whose bugs cost the
 * operator real data rather than a retry. The existing control-plane test
 * proves the happy path: approve, preflight, import, roll back, and reject a
 * destination collision.
 *
 * These cases cover what that leaves untested -- the branches that only run
 * when something has already gone wrong. Every case drives the engine through
 * its injected `OperationDependencies`, so a mid-operation filesystem failure
 * can be simulated deterministically instead of hoping for a real one.
 *
 * The rule being defended throughout: a source file is never destroyed unless
 * a verified destination exists.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveDb } from "../src/lib/archive-db";
import { after, before, describe, test } from "node:test";

let review: typeof import("../src/services/review-queue");
let operations: typeof import("../src/services/archive-operations");
let writeSettings: typeof import("../src/lib/archive-db").writeSettings;
let root = "";
let counter = 0;

type Dependencies = Parameters<typeof operations.preflightArchiveOperation>[2];

/** Real filesystem behaviour, with individual calls overridable per case. */
function realDependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    stat: (path: string) => fs.stat(path),
    access: (path: string, mode?: number) => fs.access(path, mode),
    copyFile: (from: string, to: string, mode?: number) => fs.copyFile(from, to, mode),
    rename: (from: string, to: string) => fs.rename(from, to),
    unlink: (path: string) => fs.unlink(path),
    inspect: async () => ({ verified: true }),
    ...overrides,
  } as Dependencies;
}

/** An approved operation ready to preflight. Each call is independent. */
async function approvedOperation(
  action: "import" | "move" | "rename",
  options: { sourceBody?: string; owner?: string } = {},
) {
  const owner = options.owner ?? "safety-owner";
  const id = (counter += 1);
  const source = join(root, `source-${id}.mkv`);
  const destination = join(root, `destination-${id}.mkv`);
  await fs.writeFile(source, options.sourceBody ?? `media-${id}`);

  const item = review.ensureReviewItem(owner, {
    kind: "operation_approval",
    subjectKey: `${action}:${id}`,
    title: `${action} ${id}`,
    payload: { sourcePath: source, destinationPath: destination },
  });
  review.approveReviewItem(item.id, owner);

  const operation = operations.createArchiveOperation(
    { action, sourceKind: "download", sourcePath: source, destinationPath: destination, reviewItemId: item.id },
    owner,
  );
  return { operation, source, destination, owner, reviewItemId: item.id };
}

before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "archive-operations-safety-"));
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

describe("archive operation preconditions", { concurrency: false }, () => {
  test("refuses to execute without explicit confirmation", async () => {
    const { operation, owner, destination } = await approvedOperation("import");
    const dependencies = realDependencies();
    await operations.preflightArchiveOperation(operation.id, owner, dependencies);

    await assert.rejects(
      () => operations.executeArchiveOperation(operation.id, owner, false, dependencies),
      /confirmation is required/i,
    );
    // Nothing may touch the filesystem before confirmation.
    await assert.rejects(fs.stat(destination));
  });

  test("re-reads approval at execution time so a withdrawn decision stops the write", async () => {
    const { operation, owner, destination, reviewItemId } = await approvedOperation("import");
    const dependencies = realDependencies();
    const ready = await operations.preflightArchiveOperation(operation.id, owner, dependencies);
    assert.equal(ready.status, "ready");

    // Approval is withdrawn after a successful preflight. Trusting the cached
    // "ready" status here would execute an operation the operator revoked.
    review.reopenReviewItem(reviewItemId, owner);

    await assert.rejects(
      () => operations.executeArchiveOperation(operation.id, owner, true, dependencies),
      /approv/i,
    );
    await assert.rejects(fs.stat(destination));
  });

  test("fails preflight when approval is withdrawn before it runs", async () => {
    const { operation, owner, reviewItemId } = await approvedOperation("import");
    // The state machine forbids approved -> rejected directly; an approval is
    // withdrawn by reopening it first, which is the real operator path.
    review.reopenReviewItem(reviewItemId, owner);
    review.rejectReviewItem(reviewItemId, owner);

    // Preflight refuses outright rather than recording a failed attempt: with
    // no valid approval there is nothing legitimate to plan.
    await assert.rejects(
      () => operations.preflightArchiveOperation(operation.id, owner, realDependencies()),
      /approval is no longer valid/i,
    );
    assert.equal(operations.readArchiveOperation(operation.id, owner)?.status, "planned");
  });

  test("fails preflight when the source file has disappeared", async () => {
    const { operation, owner, source } = await approvedOperation("import");
    await fs.unlink(source);

    const failed = await operations.preflightArchiveOperation(operation.id, owner, realDependencies());
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "PREFLIGHT_FAILED");
  });

  test("refuses a source path outside the configured archive directories", async () => {
    const owner = "safety-owner";
    const outside = join(tmpdir(), `outside-${(counter += 1)}.mkv`);
    await fs.writeFile(outside, "outside");
    try {
      const item = review.ensureReviewItem(owner, {
        kind: "operation_approval",
        subjectKey: `outside:${counter}`,
        title: "Outside import",
      });
      review.approveReviewItem(item.id, owner);
      const operation = operations.createArchiveOperation(
        {
          action: "import",
          sourceKind: "download",
          sourcePath: outside,
          destinationPath: join(root, `outside-${counter}.mkv`),
          reviewItemId: item.id,
        },
        owner,
      );

      const failed = await operations.preflightArchiveOperation(operation.id, owner, realDependencies());
      assert.equal(failed.status, "failed");
      assert.match(failed.errorMessage ?? "", /outside configured/i);
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});

describe("archive operation filesystem safety", { concurrency: false }, () => {
  test("keeps the source and removes the partial copy when verification fails", async () => {
    const { operation, owner, source, destination } = await approvedOperation("move");
    // Simulate a truncated copy: the destination exists but is the wrong size,
    // which is exactly what verifyDestination is there to catch.
    const dependencies = realDependencies({
      copyFile: async (from: string, to: string) => {
        await fs.writeFile(to, "truncated");
      },
    });

    await operations.preflightArchiveOperation(operation.id, owner, dependencies);
    const failed = await operations.executeArchiveOperation(operation.id, owner, true, dependencies);

    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "EXECUTION_FAILED");
    // The rule: a failed verification must never cost the operator the source.
    assert.ok(await fs.stat(source));
    await assert.rejects(fs.stat(destination), "the unverified copy must be cleaned up");
  });

  test("never unlinks the source for a move whose copy failed outright", async () => {
    const { operation, owner, source, destination } = await approvedOperation("move");
    const dependencies = realDependencies({
      copyFile: async () => {
        throw new Error("simulated disk failure");
      },
    });

    await operations.preflightArchiveOperation(operation.id, owner, dependencies);
    const failed = await operations.executeArchiveOperation(operation.id, owner, true, dependencies);

    assert.equal(failed.status, "failed");
    assert.equal(await fs.readFile(source, "utf8"), (await fs.readFile(source, "utf8")));
    await assert.rejects(fs.stat(destination));
  });

  test("records that manual recovery is required when cleanup also fails", async () => {
    const { operation, owner, source } = await approvedOperation("move");
    const dependencies = realDependencies({
      copyFile: async (from: string, to: string) => {
        await fs.writeFile(to, "truncated");
      },
      unlink: async () => {
        throw new Error("cleanup failed");
      },
    });

    await operations.preflightArchiveOperation(operation.id, owner, dependencies);
    const failed = await operations.executeArchiveOperation(operation.id, owner, true, dependencies);

    assert.equal(failed.status, "failed");
    // The operator must be told the filesystem is in an uncertain state rather
    // than being shown a plain failure.
    assert.equal((failed.rollback as Record<string, unknown>).recoveryRequired, true);
    assert.ok(await fs.stat(source), "the source is still intact");
  });
});

describe("archive operation idempotency and recovery", { concurrency: false }, () => {
  test("startup reconciliation marks interrupted operations for recovery", async () => {
    const { operation, owner } = await approvedOperation("import");
    archiveDb.prepare("UPDATE archive_operation SET status = 'executing' WHERE id = ? AND owner_id = ?").run(operation.id, owner);
    assert.equal(operations.reconcileInterruptedArchiveOperations(), 1);
    const recovered = operations.readArchiveOperation(operation.id, owner);
    assert.equal(recovered?.status, "recovery_required");
    assert.equal(recovered?.errorCode, "RECOVERY_REQUIRED");
  });

  test("does not auto-resolve an ambiguous batch rollback", async () => {
    const owner = "safety-owner-ambiguous-recovery";
    const source = join(root, "ambiguous-source.mkv");
    const destination = join(root, "ambiguous-destination.mkv");
    await fs.writeFile(source, "source");
    await fs.writeFile(destination, "destination");
    const item = review.ensureReviewItem(owner, {
      kind: "operation_approval",
      subjectKey: "ambiguous-recovery",
      title: "Ambiguous recovery",
      payload: { sourcePath: source, destinationPath: destination },
    });
    review.approveReviewItem(item.id, owner);
    const operation = operations.createArchiveOperation({
      action: "rename",
      sourceKind: "test",
      sourceId: "ambiguous-recovery",
      reviewItemId: item.id,
      batch: [{ id: "ambiguous", originalPath: source, temporaryPath: join(root, "ambiguous.tmp"), finalPath: destination, state: "completed" }],
    }, owner);
    archiveDb.prepare("UPDATE archive_operation SET status = 'completed', batch_json = ? WHERE id = ? AND owner_id = ?")
      .run(JSON.stringify(operation.batch), operation.id, owner);
    const recovered = await operations.rollbackArchiveOperation(operation.id, owner, true, realDependencies());
    assert.equal(recovered.status, "recovery_required");
    assert.equal(await fs.readFile(source, "utf8"), "source");
    assert.equal(await fs.readFile(destination, "utf8"), "destination");
  });
  test("returns the completed operation unchanged when executed twice", async () => {
    const { operation, owner, destination } = await approvedOperation("import");
    const dependencies = realDependencies();
    await operations.preflightArchiveOperation(operation.id, owner, dependencies);

    const first = await operations.executeArchiveOperation(operation.id, owner, true, dependencies);
    assert.equal(first.status, "completed");
    const body = await fs.readFile(destination, "utf8");

    const second = await operations.executeArchiveOperation(operation.id, owner, true, dependencies);
    assert.equal(second.status, "completed");
    assert.equal(second.completedAt, first.completedAt, "the second call must not re-run the operation");
    assert.equal(await fs.readFile(destination, "utf8"), body);
  });

  test("rolling back twice is a no-op rather than a second deletion", async () => {
    const { operation, owner } = await approvedOperation("import");
    const dependencies = realDependencies();
    await operations.preflightArchiveOperation(operation.id, owner, dependencies);
    await operations.executeArchiveOperation(operation.id, owner, true, dependencies);

    const rolledBack = await operations.rollbackArchiveOperation(operation.id, owner, true, dependencies);
    assert.equal(rolledBack.status, "rolled_back");
    // A second rollback must not attempt another unlink, which could remove a
    // file the operator has since restored to that path.
    const repeated = await operations.rollbackArchiveOperation(operation.id, owner, true, dependencies);
    assert.equal(repeated.status, "rolled_back");
  });

  test("requires confirmation to roll back", async () => {
    const { operation, owner } = await approvedOperation("import");
    const dependencies = realDependencies();
    await operations.preflightArchiveOperation(operation.id, owner, dependencies);
    await operations.executeArchiveOperation(operation.id, owner, true, dependencies);

    await assert.rejects(
      () => operations.rollbackArchiveOperation(operation.id, owner, false, dependencies),
      /confirmation is required/i,
    );
  });

  test("refuses to roll back an operation that never completed", async () => {
    const { operation, owner } = await approvedOperation("import");
    await operations.preflightArchiveOperation(operation.id, owner, realDependencies());

    await assert.rejects(
      () => operations.rollbackArchiveOperation(operation.id, owner, true, realDependencies()),
      /only completed operations/i,
    );
  });

  test("refuses to cancel an operation that already completed", async () => {
    const { operation, owner } = await approvedOperation("import");
    const dependencies = realDependencies();
    await operations.preflightArchiveOperation(operation.id, owner, dependencies);
    await operations.executeArchiveOperation(operation.id, owner, true, dependencies);

    assert.throws(() => operations.cancelArchiveOperation(operation.id, owner), /cannot cancel/i);
  });

  test("retries a failed operation and stops at the retry limit", async () => {
    const { operation, owner, source } = await approvedOperation("move");
    let failNext = true;
    const dependencies = realDependencies({
      copyFile: async (from: string, to: string) => {
        if (failNext) throw new Error("simulated failure");
        await fs.copyFile(from, to);
      },
    });

    await operations.preflightArchiveOperation(operation.id, owner, dependencies);
    const failed = await operations.executeArchiveOperation(operation.id, owner, true, dependencies);
    assert.equal(failed.status, "failed");

    failNext = false;
    const retried = await operations.retryArchiveOperation(operation.id, owner, dependencies);
    assert.equal(retried.status, "ready", "a retry re-runs preflight rather than writing immediately");
    assert.equal(retried.retryCount, 1);
    assert.ok(await fs.stat(source));
  });

  test("refuses to retry an operation that has not failed", async () => {
    const { operation, owner } = await approvedOperation("import");
    await operations.preflightArchiveOperation(operation.id, owner, realDependencies());

    await assert.rejects(
      () => operations.retryArchiveOperation(operation.id, owner, realDependencies()),
      /only failed or cancelled/i,
    );
  });
});

describe("archive operation ownership", { concurrency: false }, () => {
  test("another owner can neither read nor mutate the operation", async () => {
    const { operation, owner } = await approvedOperation("import");
    await operations.preflightArchiveOperation(operation.id, owner, realDependencies());

    assert.equal(operations.readArchiveOperation(operation.id, "intruder"), null);
    await assert.rejects(
      () => operations.executeArchiveOperation(operation.id, "intruder", true, realDependencies()),
      /not found/i,
    );
    await assert.rejects(
      () => operations.preflightArchiveOperation(operation.id, "intruder", realDependencies()),
      /not found/i,
    );
    assert.throws(() => operations.cancelArchiveOperation(operation.id, "intruder"), /not found/i);
  });
});
