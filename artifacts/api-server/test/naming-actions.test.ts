import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, test } from "node:test";

let namingActions: typeof import("../src/services/naming-actions");
let engine: typeof import("../src/services/action-engine");
let writeSettings: typeof import("../src/lib/archive-db").writeSettings;
let root = "";

const owner = "naming-action-owner";

/**
 * Naming intelligence recognizes canonical Windows archive volumes, so its
 * output is injected here rather than depending on the host platform. These
 * rows mirror the real shape produced by readNamingProposals.
 */
function namingProposal(overrides: Record<string, unknown>) {
  return {
    fileRecordId: 1,
    localIdentityId: null,
    sourcePath: "/archive/Example Show/Season 01/01 - Pilot.mkv",
    proposedPath: "/archive/Example Show/Season 01/Example Show - S01E01 - Pilot.mkv",
    sourceFilename: "01 - Pilot.mkv",
    proposedFilename: "Example Show - S01E01 - Pilot.mkv",
    currentIdentity: null,
    proposedIdentity: { show: "Example Show", season: 1, episode: 1 },
    patternId: "directory_show_season_episode_number",
    confidence: "high",
    operation: "rename",
    reason: "show directory; Season N directory; leading episode number",
    evidence: ["show directory", "Season N directory", "leading episode number"],
    mediaType: "tv",
    volumeId: "d-tv",
    archiveRoot: "/archive",
    collision: false,
    ...overrides,
  };
}

const report = {
  results: [
    namingProposal({}),
    namingProposal({
      fileRecordId: 2,
      sourcePath: "/archive/Example Show/Season 01/02 - Second Contact.mkv",
      proposedPath: "/archive/Example Show/Season 01/Example Show - S01E02 - Second Contact.mkv",
      sourceFilename: "02 - Second Contact.mkv",
      proposedFilename: "Example Show - S01E02 - Second Contact.mkv",
    }),
    // Restructure crosses directories, so it becomes a move rather than a rename.
    namingProposal({
      fileRecordId: 3,
      operation: "restructure",
      sourcePath: "/archive/Loose/03 - Stray.mkv",
      proposedPath: "/archive/Example Show/Season 01/Example Show - S01E03 - Stray.mkv",
      sourceFilename: "03 - Stray.mkv",
      proposedFilename: "Example Show - S01E03 - Stray.mkv",
    }),
    // Advisory-only rows must never become executable steps.
    namingProposal({
      fileRecordId: 4,
      operation: "uncertain/no_action",
      proposedPath: null,
      proposedFilename: null,
      confidence: "uncertain",
    }),
    namingProposal({
      fileRecordId: 5,
      collision: true,
      sourcePath: "/archive/Example Show/Season 01/05 - Collide.mkv",
      proposedPath: "/archive/Example Show/Season 01/Example Show - S01E01 - Pilot.mkv",
    }),
  ],
};

const reader = async () => report;

before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "archive-naming-actions-"));
  ({ writeSettings } = await import("../src/lib/archive-db"));
  namingActions = await import("../src/services/naming-actions");
  engine = await import("../src/services/action-engine");
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

describe("naming findings become action proposals", { concurrency: false }, () => {
  test("offers actions only for findings that are safely executable", async () => {
    const preview = await namingActions.readNamingActionCandidates(owner, {}, reader);
    assert.equal(preview.summary.inspected, 5);
    // Uncertain and colliding findings stay advisory.
    assert.equal(preview.summary.actionable, 3);
    assert.equal(preview.summary.skipped, 2);
    assert.equal(preview.summary.rename, 2);
    assert.equal(preview.summary.move, 1);
    for (const candidate of preview.candidates) {
      assert.notEqual(candidate.sourcePath, candidate.destinationPath);
      assert.ok(candidate.evidence.length > 0, "each candidate carries its evidence");
    }
  });

  test("plans one reviewable proposal holding every exact file mapping", async () => {
    const proposal = await namingActions.planNamingNormalization(owner, {}, reader);
    assert.equal(proposal.source, "naming_intelligence");
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.requiresApproval, true);
    assert.equal(proposal.counts.total, 3);
    assert.equal(proposal.counts.selected, 3);
    assert.equal(proposal.approvedAt, null);
    // A plan containing a cross-directory move is classified as the riskier type.
    assert.equal(proposal.type, "move");
    assert.equal(proposal.risk, "medium");
    assert.deepEqual(
      proposal.steps.map((step) => step.type),
      ["rename", "rename", "move"],
    );
    for (const step of proposal.steps) {
      assert.ok(step.before.path, "step records the current path");
      assert.ok(step.after.path, "step records the proposed path");
      assert.match(step.summary, /→/);
      assert.equal(step.target.kind, "file_record");
    }
    assert.equal(proposal.evidence.inspected, 5);
    assert.ok(Array.isArray(proposal.evidence.patterns));

    // Planning is idempotent for unchanged evidence.
    const repeated = await namingActions.planNamingNormalization(owner, {}, reader);
    assert.equal(repeated.id, proposal.id);
  });

  test("restricts a plan to the findings the operator selected", async () => {
    const proposal = await namingActions.planNamingNormalization(owner, {
      fileRecordIds: [2],
    }, reader);
    assert.equal(proposal.counts.total, 1);
    assert.equal(proposal.type, "rename");
    assert.equal(proposal.risk, "low");
    assert.equal(proposal.steps[0].target.id, "2");
  });

  test("refuses to plan when no finding is actionable", async () => {
    await assert.rejects(
      namingActions.planNamingNormalization(owner, {}, async () => ({
        results: [namingProposal({ operation: "uncertain/no_action", proposedPath: null })],
      })),
      /No actionable naming findings/,
    );
  });

  test("leaves planned proposals inert until the operator approves them", async () => {
    const proposal = await namingActions.planNamingNormalization(owner, {}, reader);
    const stored = engine.readActionProposal(proposal.id, owner);
    assert.ok(stored);
    assert.equal(stored.status, "proposed");
    assert.equal(stored.executedAt, null);
    assert.equal(stored.reviewItemId, null);
    // Nothing may reach preflight without an explicit approval decision.
    await assert.rejects(
      engine.preflightActionProposal(proposal.id, owner),
      /Cannot preflight a proposal in proposed state/,
    );
    // And the proposal is owner-scoped.
    assert.equal(engine.readActionProposal(proposal.id, "different-owner"), null);
  });
});
