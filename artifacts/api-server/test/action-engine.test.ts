import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, test } from "node:test";

let engine: typeof import("../src/services/action-engine");
let review: typeof import("../src/services/review-queue");
let writeSettings: typeof import("../src/lib/archive-db").writeSettings;
let root = "";

/** Filesystem seam so the engine is exercised without touching a real archive. */
function dependencies() {
  return {
    stat: (path: string) => fs.stat(path),
    access: (path: string, mode?: number) => fs.access(path, mode),
    copyFile: (from: string, to: string, mode?: number) => fs.copyFile(from, to, mode),
    rename: (from: string, to: string) => fs.rename(from, to),
    unlink: (path: string) => fs.unlink(path),
    mkdir: async (path: string) => {
      await fs.mkdir(path, { recursive: true });
    },
    rmdir: (path: string) => fs.rmdir(path),
    inspect: async () => ({ verified: true, container: "matroska" }),
  };
}

before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "archive-action-engine-"));
  ({ writeSettings } = await import("../src/lib/archive-db"));
  engine = await import("../src/services/action-engine");
  review = await import("../src/services/review-queue");
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

describe("action capability registry", { concurrency: false }, () => {
  test("declares every action type and only reports wired families as supported", () => {
    const capabilities = engine.listActionCapabilities();
    assert.equal(capabilities.length, engine.actionTypes.length);
    const supported = capabilities.filter((capability) => capability.supported).map((c) => c.type);
    assert.deepEqual(supported.sort(), ["import", "move", "reconcile", "rename"]);
    // reconcile is the first supported family that changes no bytes on disk.
    const reconcile = capabilities.find((capability) => capability.type === "reconcile");
    assert.equal(reconcile?.mutatesFiles, false);
    // A link is pure engine-owned record state, so undo restores it exactly.
    assert.equal(reconcile?.reversibility.kind, "reversible");
    assert.deepEqual(reconcile?.reversibility.conditions, []);
    // Declared-but-unimplemented families must refuse to plan rather than pretend.
    assert.throws(() => engine.requireSupportedHandler("delete"), /not implemented yet/);
  });

  test("reports reversibility honestly, including the conditional middle ground", () => {
    const byType = new Map(engine.listActionCapabilities().map((c) => [c.type, c]));

    // rename/move revert by putting the file back, but that throws when the
    // original path has been taken. A boolean could not say this, so the UI
    // used to promise an undo the engine might refuse.
    for (const type of ["rename", "move", "import"] as const) {
      const capability = byType.get(type);
      assert.equal(capability?.reversibility.kind, "conditional");
      assert.ok((capability?.reversibility.conditions.length ?? 0) > 0);
      assert.ok(capability?.reversibility.strategy);
    }

    // Irreversible families must say so and must not offer a strategy.
    for (const type of ["delete", "plex_sync"] as const) {
      const capability = byType.get(type);
      assert.equal(capability?.reversibility.kind, "irreversible");
      assert.equal(capability?.reversibility.strategy, null);
    }

    // Every family explains itself in operator language.
    for (const capability of byType.values()) {
      assert.ok(capability.reversibility.explanation.length > 20, capability.type);
    }
  });
});

describe("universal action lifecycle", { concurrency: false }, () => {
  test("runs propose → approve → preflight → execute → verify → revert for a batch", async () => {
    const owner = "action-owner";
    const first = join(root, "show.s01e01.mkv");
    const second = join(root, "show.s01e02.mkv");
    await fs.writeFile(first, "episode-one");
    await fs.writeFile(second, "episode-two");
    const firstTarget = join(root, "Show - S01E01.mkv");
    const secondTarget = join(root, "Show - S01E02.mkv");

    const proposal = engine.createActionProposal(owner, {
      type: "rename",
      source: "naming_intelligence",
      reason: "Normalize 2 inconsistent filenames.",
      steps: [
        { type: "rename", before: { path: first }, after: { path: firstTarget } },
        { type: "rename", before: { path: second }, after: { path: secondTarget } },
      ],
    });
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.counts.total, 2);
    assert.equal(proposal.requiresApproval, true);

    // Proposing is idempotent: the same evidence must not create a second plan.
    const repeated = engine.createActionProposal(owner, {
      type: "rename",
      source: "naming_intelligence",
      reason: "Normalize 2 inconsistent filenames.",
      steps: [
        { type: "rename", before: { path: first }, after: { path: firstTarget } },
        { type: "rename", before: { path: second }, after: { path: secondTarget } },
      ],
    });
    assert.equal(repeated.id, proposal.id);

    // Nothing may run before approval.
    await assert.rejects(
      engine.preflightActionProposal(proposal.id, owner, dependencies()),
      /Cannot preflight a proposal in proposed state/,
    );
    assert.equal(await fs.readFile(first, "utf8"), "episode-one");

    const approved = engine.approveActionProposal(proposal.id, owner, "Checked the mapping.");
    assert.equal(approved.status, "approved");
    assert.ok(approved.approvedAt);
    assert.ok(approved.reviewItemId, "approval is recorded in the review queue");

    const ready = await engine.preflightActionProposal(proposal.id, owner, dependencies());
    assert.equal(ready.status, "ready");
    assert.equal(ready.preflight.passed, 2);
    // Preflight must not touch the filesystem.
    assert.equal(await fs.readFile(first, "utf8"), "episode-one");

    await assert.rejects(
      engine.executeActionProposal(proposal.id, owner, false, dependencies()),
      /Explicit execution confirmation is required/,
    );

    const completed = await engine.executeActionProposal(proposal.id, owner, true, dependencies());
    assert.equal(completed.status, "completed");
    assert.equal(completed.counts.completed, 2);
    assert.equal(await fs.readFile(firstTarget, "utf8"), "episode-one");
    assert.equal(await fs.readFile(secondTarget, "utf8"), "episode-two");
    await assert.rejects(fs.stat(first));
    assert.ok(completed.steps.every((step) => step.verification.verified === true));

    const history = completed.events.map((event) => event.phase);
    for (const phase of ["propose", "approve", "preflight", "execute", "verify", "record"]) {
      assert.ok(history.includes(phase as never), `history records the ${phase} phase`);
    }

    const reverted = await engine.revertActionProposal(proposal.id, owner, true, dependencies());
    assert.equal(reverted.status, "reverted");
    assert.equal(await fs.readFile(first, "utf8"), "episode-one");
    await assert.rejects(fs.stat(firstTarget));
  });

  test("honors per-step deselection so a batch can be partially approved", async () => {
    const owner = "selection-owner";
    const keep = join(root, "keep.s01e01.mkv");
    const skip = join(root, "skip.s01e01.mkv");
    await fs.writeFile(keep, "keep");
    await fs.writeFile(skip, "skip");
    const keepTarget = join(root, "Keep - S01E01.mkv");
    const skipTarget = join(root, "Skip - S01E01.mkv");

    const proposal = engine.createActionProposal(owner, {
      type: "rename",
      source: "naming_intelligence",
      reason: "Normalize 2 filenames.",
      steps: [
        { type: "rename", before: { path: keep }, after: { path: keepTarget } },
        { type: "rename", before: { path: skip }, after: { path: skipTarget } },
      ],
    });
    const skipped = proposal.steps[1];
    const updated = engine.setActionStepSelection(proposal.id, owner, [
      { stepId: skipped.id, selected: false },
    ]);
    assert.equal(updated.counts.selected, 1);
    assert.equal(updated.steps[1].status, "skipped");

    engine.approveActionProposal(proposal.id, owner);
    await engine.preflightActionProposal(proposal.id, owner, dependencies());
    const completed = await engine.executeActionProposal(proposal.id, owner, true, dependencies());
    assert.equal(completed.status, "completed");
    assert.equal(completed.counts.completed, 1);
    assert.equal(await fs.readFile(keepTarget, "utf8"), "keep");
    // The deselected file must be untouched.
    assert.equal(await fs.readFile(skip, "utf8"), "skip");
    await assert.rejects(fs.stat(skipTarget));
  });
});

describe("action safety boundaries", { concurrency: false }, () => {
  test("rejects an approved plan that changed before execution", async () => {
    const owner = "tamper-owner";
    const source = join(root, "tamper.mkv");
    await fs.writeFile(source, "tamper");
    const proposal = engine.createActionProposal(owner, {
      type: "rename",
      source: "naming_intelligence",
      reason: "Rename one file.",
      steps: [{ type: "rename", before: { path: source }, after: { path: join(root, "Tamper.mkv") } }],
    });
    engine.approveActionProposal(proposal.id, owner);
    // The plan is locked once approved: selection cannot change underneath it.
    assert.throws(
      () => engine.setActionStepSelection(proposal.id, owner, [
        { stepId: proposal.steps[0].id, selected: false },
      ]),
      /Cannot change step selection while the proposal is approved/,
    );
    // Simulate out-of-band tampering with the stored plan after approval.
    const { archiveDb } = await import("../src/lib/archive-db");
    archiveDb.prepare("UPDATE action_step SET after_json = ? WHERE proposal_id = ?")
      .run(JSON.stringify({ path: join(root, "Hijacked.mkv") }), proposal.id);

    const result = await engine.preflightActionProposal(proposal.id, owner, dependencies());
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "PLAN_CHANGED");
    await assert.rejects(fs.stat(join(root, "Hijacked.mkv")));
    assert.equal(await fs.readFile(source, "utf8"), "tamper");
  });

  test("refuses collisions, paths outside the archive, and stale approvals", async () => {
    const owner = "boundary-owner";
    const source = join(root, "boundary.mkv");
    const occupied = join(root, "occupied.mkv");
    await fs.writeFile(source, "boundary");
    await fs.writeFile(occupied, "already-here");

    const collision = engine.createActionProposal(owner, {
      type: "rename",
      source: "naming_intelligence",
      reason: "Collide with an existing file.",
      steps: [{ type: "rename", before: { path: source }, after: { path: occupied } }],
    });
    engine.approveActionProposal(collision.id, owner);
    const collided = await engine.preflightActionProposal(collision.id, owner, dependencies());
    assert.equal(collided.status, "failed");
    assert.match(collided.steps[0].errorMessage ?? "", /collision/i);
    assert.equal(await fs.readFile(occupied, "utf8"), "already-here");

    const escape = engine.createActionProposal(owner, {
      type: "rename",
      source: "naming_intelligence",
      reason: "Escape the archive root.",
      steps: [{
        type: "rename",
        before: { path: join(tmpdir(), "outside-source.mkv") },
        after: { path: join(root, "inside.mkv") },
      }],
    });
    engine.approveActionProposal(escape.id, owner);
    const escaped = await engine.preflightActionProposal(escape.id, owner, dependencies());
    assert.equal(escaped.status, "failed");
    assert.match(escaped.steps[0].errorMessage ?? "", /outside configured/i);

    // Two steps must not race for the same destination inside one plan.
    const alpha = join(root, "alpha.mkv");
    const beta = join(root, "beta.mkv");
    await fs.writeFile(alpha, "alpha");
    await fs.writeFile(beta, "beta");
    const shared = join(root, "Shared.mkv");
    const internal = engine.createActionProposal(owner, {
      type: "rename",
      source: "naming_intelligence",
      reason: "Two steps target one destination.",
      steps: [
        { type: "rename", before: { path: alpha }, after: { path: shared } },
        { type: "rename", before: { path: beta }, after: { path: shared } },
      ],
    });
    engine.approveActionProposal(internal.id, owner);
    const conflicted = await engine.preflightActionProposal(internal.id, owner, dependencies());
    assert.equal(conflicted.status, "ready");
    assert.equal(conflicted.counts.failed, 1);
    assert.match(conflicted.steps[1].errorMessage ?? "", /already targets the same destination/i);
  });

  test("keeps proposals owner-scoped and blocks execution when approval is withdrawn", async () => {
    const owner = "scoped-owner";
    const source = join(root, "scoped.mkv");
    await fs.writeFile(source, "scoped");
    const proposal = engine.createActionProposal(owner, {
      type: "rename",
      source: "naming_intelligence",
      reason: "Rename a scoped file.",
      steps: [{ type: "rename", before: { path: source }, after: { path: join(root, "Scoped.mkv") } }],
    });
    assert.equal(engine.readActionProposal(proposal.id, "someone-else"), null);

    const approved = engine.approveActionProposal(proposal.id, owner);
    await engine.preflightActionProposal(proposal.id, owner, dependencies());
    // Reopening the linked review withdraws approval; execution must stop.
    review.reopenReviewItem(approved.reviewItemId!, owner, "Changed my mind.");
    await assert.rejects(
      engine.executeActionProposal(proposal.id, owner, true, dependencies()),
      /approved review item is required/,
    );
    assert.equal(await fs.readFile(source, "utf8"), "scoped");
  });

  test("records partial completion and reverts only what succeeded", async () => {
    const owner = "partial-owner";
    const good = join(root, "good.mkv");
    const vanishing = join(root, "vanishing.mkv");
    await fs.writeFile(good, "good");
    await fs.writeFile(vanishing, "vanishing");
    const goodTarget = join(root, "Good.mkv");
    const vanishingTarget = join(root, "Vanishing.mkv");

    const proposal = engine.createActionProposal(owner, {
      type: "rename",
      source: "naming_intelligence",
      reason: "One step will fail during execution.",
      steps: [
        { type: "rename", before: { path: good }, after: { path: goodTarget } },
        { type: "rename", before: { path: vanishing }, after: { path: vanishingTarget } },
      ],
    });
    engine.approveActionProposal(proposal.id, owner);
    await engine.preflightActionProposal(proposal.id, owner, dependencies());
    // The file disappears between preflight and execute — the classic race.
    await fs.rm(vanishing);

    const result = await engine.executeActionProposal(proposal.id, owner, true, dependencies());
    assert.equal(result.status, "partially_completed");
    assert.equal(result.counts.completed, 1);
    assert.equal(result.counts.failed, 1);
    assert.equal(await fs.readFile(goodTarget, "utf8"), "good");

    const reverted = await engine.revertActionProposal(proposal.id, owner, true, dependencies());
    assert.equal(reverted.status, "reverted");
    assert.equal(await fs.readFile(good, "utf8"), "good");
  });
});
