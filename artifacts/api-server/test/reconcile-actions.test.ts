import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

let reconcileActions: typeof import("../src/services/reconcile-actions");
let engine: typeof import("../src/services/action-engine");
let archiveDb: typeof import("../src/lib/archive-db").archiveDb;

const owner = "reconcile-action-owner";

/**
 * Reconciliation output is injected rather than derived, for the same reason
 * naming-actions injects its report: building a real one needs a populated
 * Plex snapshot plus canonical Windows archive volumes. These rows mirror the
 * real shape produced by readReconciliationReport.
 */
function reconciliationRow(overrides: Record<string, unknown> = {}) {
  return {
    classification: "matched",
    matchingStrategy: "tv_show_season_episode",
    candidateCount: 1,
    local: {
      fileRecordId: 1,
      localMediaIdentityId: null,
      path: "/archive/Example Show/Season 01/S01E01.mkv",
      relativePath: "Example Show/Season 01/S01E01.mkv",
      volumeId: "d-tv",
      archiveRoot: "/archive",
      mediaType: "tv",
      identity: { show: "example show", season: 1, episode: 1, strategy: "tv_show_season_episode" },
      scanStatus: "active",
    },
    plex: {
      id: 10,
      ratingKey: "plex-1",
      libraryId: 1,
      libraryName: "TV Shows",
      title: "Pilot",
      year: 2019,
      itemType: "episode",
      identity: { show: "example show", season: 1, episode: 1, strategy: "tv_show_season_episode" },
    },
    ambiguityCandidates: [],
    quality: { status: "equivalent_available_metadata", differences: [] },
    ...overrides,
  };
}

function reportOf(results: unknown[]) {
  return async () => ({ summary: {}, results });
}

/** Seed the rows preflight re-reads, so the engine validates against real state. */
function seedRecords(fileRecordId: number, ratingKey: string, scanStatus = "active") {
  archiveDb.prepare(
    `INSERT OR REPLACE INTO file_record (id, owner_id, path, filename, relative_path, scan_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(fileRecordId, owner, `/archive/file-${fileRecordId}.mkv`, `file-${fileRecordId}.mkv`, `file-${fileRecordId}.mkv`, scanStatus);
  archiveDb.prepare(
    `INSERT OR IGNORE INTO plex_library (id, name, server_url, library_key, owner_id)
     VALUES (1, 'TV Shows', 'http://localhost:32400', '1', ?)`,
  ).run(owner);
  archiveDb.prepare(
    `INSERT OR REPLACE INTO plex_item (library_id, rating_key, title, item_type, owner_id)
     VALUES (1, ?, 'Pilot', 'episode', ?)`,
  ).run(ratingKey, owner);
}

before(async () => {
  reconcileActions = await import("../src/services/reconcile-actions");
  engine = await import("../src/services/action-engine");
  ({ archiveDb } = await import("../src/lib/archive-db"));
});

describe("reconcile action candidates", { concurrency: false }, () => {
  test("offers only unambiguous single-candidate matches", async () => {
    const result = await reconcileActions.readReconcileActionCandidates(owner, {}, reportOf([
      reconciliationRow(),
      // Several plausible Plex items: the operator must not rubber-stamp a guess.
      reconciliationRow({ classification: "uncertain", candidateCount: 3, local: { ...reconciliationRow().local, fileRecordId: 2 } }),
      // No Plex side at all.
      reconciliationRow({ classification: "local_only", candidateCount: 0, plex: null, local: { ...reconciliationRow().local, fileRecordId: 3 } }),
      // No local side at all.
      reconciliationRow({ classification: "plex_only", candidateCount: 0, local: null }),
    ]));

    assert.equal(result.summary.inspected, 4);
    assert.equal(result.summary.actionable, 1);
    assert.equal(result.summary.uncertain, 1);
    assert.equal(result.summary.skipped, 3);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].ratingKey, "plex-1");
  });

  test("treats a quality conflict as linkable but records the conflict", async () => {
    const result = await reconcileActions.readReconcileActionCandidates(owner, {}, reportOf([
      reconciliationRow({
        classification: "quality_conflict",
        quality: { status: "conflict", differences: ["height"] },
      }),
    ]));
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].qualityStatus, "conflict");
  });

  test("refuses to plan when nothing is unambiguous", async () => {
    await assert.rejects(
      () => reconcileActions.planReconciliation(owner, {}, reportOf([
        reconciliationRow({ classification: "uncertain", candidateCount: 2 }),
      ])),
      /No unambiguous reconciliation matches/,
    );
  });
});

describe("reconcile action lifecycle", { concurrency: false }, () => {
  test("runs propose → approve → preflight → execute → verify → revert without touching files", async () => {
    seedRecords(101, "plex-101");
    const proposal = await reconcileActions.planReconciliation(owner, {}, reportOf([
      reconciliationRow({
        local: { ...reconciliationRow().local, fileRecordId: 101 },
        plex: { ...reconciliationRow().plex, ratingKey: "plex-101" },
      }),
    ]));

    assert.equal(proposal.type, "reconcile");
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.steps.length, 1);
    // The Before → After of a record action is an identity, not a path.
    assert.equal(proposal.steps[0].before.linked, false);
    assert.equal(proposal.steps[0].after.ratingKey, "plex-101");
    assert.equal(proposal.steps[0].after.path, undefined);

    engine.approveActionProposal(proposal.id, owner);
    const preflighted = await engine.preflightActionProposal(proposal.id, owner);
    assert.equal(preflighted.status, "ready");
    // Nothing is linked until execution.
    assert.equal(
      archiveDb.prepare(`SELECT COUNT(*) AS n FROM media_identity_link WHERE owner_id = ?`).get(owner).n,
      0,
    );

    const executed = await engine.executeActionProposal(proposal.id, owner, true, undefined, { postflight: false });
    assert.equal(executed.status, "completed");
    assert.equal(executed.counts.completed, 1);
    const link = archiveDb.prepare(
      `SELECT plex_rating_key, confidence FROM media_identity_link WHERE owner_id = ? AND file_record_id = 101`,
    ).get(owner) as { plex_rating_key: string; confidence: string };
    assert.equal(link.plex_rating_key, "plex-101");
    assert.equal(link.confidence, "confirmed");

    const reverted = await engine.revertActionProposal(proposal.id, owner, true);
    assert.equal(reverted.status, "reverted");
    assert.equal(
      archiveDb.prepare(`SELECT COUNT(*) AS n FROM media_identity_link WHERE owner_id = ? AND file_record_id = 101`).get(owner).n,
      0,
    );
  });

  test("preflight refuses when the local file is no longer active", async () => {
    seedRecords(102, "plex-102", "missing");
    const proposal = await reconcileActions.planReconciliation(owner, {}, reportOf([
      reconciliationRow({
        local: { ...reconciliationRow().local, fileRecordId: 102 },
        plex: { ...reconciliationRow().plex, ratingKey: "plex-102" },
      }),
    ]));
    engine.approveActionProposal(proposal.id, owner);
    const preflighted = await engine.preflightActionProposal(proposal.id, owner);
    assert.equal(preflighted.status, "failed");
    assert.match(String(preflighted.steps[0].errorMessage), /no longer active/);
  });

  test("preflight refuses to steal a Plex item already linked to another file", async () => {
    seedRecords(103, "plex-103");
    seedRecords(104, "plex-104");
    // 103 is already confirmed against plex-103.
    archiveDb.prepare(
      `INSERT INTO media_identity_link (owner_id, file_record_id, plex_rating_key, identity_key)
       VALUES (?, 103, 'plex-103', 'k')`,
    ).run(owner);

    const proposal = await reconcileActions.planReconciliation(owner, {}, reportOf([
      reconciliationRow({
        local: { ...reconciliationRow().local, fileRecordId: 104 },
        plex: { ...reconciliationRow().plex, ratingKey: "plex-103" },
      }),
    ]));
    engine.approveActionProposal(proposal.id, owner);
    const preflighted = await engine.preflightActionProposal(proposal.id, owner);
    assert.equal(preflighted.status, "failed");
    assert.match(String(preflighted.steps[0].errorMessage), /already linked to a different local file/);
  });

  test("preflight refuses to silently move a file's existing confirmed link", async () => {
    seedRecords(105, "plex-105");
    archiveDb.prepare(
      `INSERT OR REPLACE INTO plex_item (library_id, rating_key, title, item_type, owner_id)
       VALUES (1, 'plex-105b', 'Pilot', 'episode', ?)`,
    ).run(owner);
    archiveDb.prepare(
      `INSERT INTO media_identity_link (owner_id, file_record_id, plex_rating_key, identity_key)
       VALUES (?, 105, 'plex-105', 'k')`,
    ).run(owner);

    const proposal = await reconcileActions.planReconciliation(owner, {}, reportOf([
      reconciliationRow({
        local: { ...reconciliationRow().local, fileRecordId: 105 },
        plex: { ...reconciliationRow().plex, ratingKey: "plex-105b" },
      }),
    ]));
    engine.approveActionProposal(proposal.id, owner);
    const preflighted = await engine.preflightActionProposal(proposal.id, owner);
    assert.equal(preflighted.status, "failed");
    assert.match(String(preflighted.steps[0].errorMessage), /already linked to a different Plex item/);
    // The operator's earlier decision is left exactly as it was.
    assert.equal(
      (archiveDb.prepare(`SELECT plex_rating_key AS k FROM media_identity_link WHERE owner_id = ? AND file_record_id = 105`).get(owner) as { k: string }).k,
      "plex-105",
    );
  });

  test("re-confirming an existing link is idempotent, and revert does not delete it", async () => {
    seedRecords(108, "plex-108");
    // The link already exists before this proposal is created.
    archiveDb.prepare(
      `INSERT INTO media_identity_link (owner_id, file_record_id, plex_rating_key, identity_key)
       VALUES (?, 108, 'plex-108', 'k')`,
    ).run(owner);

    const proposal = await reconcileActions.planReconciliation(owner, {}, reportOf([
      reconciliationRow({
        local: { ...reconciliationRow().local, fileRecordId: 108 },
        plex: { ...reconciliationRow().plex, ratingKey: "plex-108" },
      }),
    ]));
    engine.approveActionProposal(proposal.id, owner);
    const preflighted = await engine.preflightActionProposal(proposal.id, owner);
    assert.equal(preflighted.status, "ready");
    assert.equal(preflighted.steps[0].preflight.alreadyLinked, true);

    const executed = await engine.executeActionProposal(proposal.id, owner, true, undefined, { postflight: false });
    assert.equal(executed.status, "completed");

    await engine.revertActionProposal(proposal.id, owner, true);
    // Revert undoes what this proposal did — it must not destroy a link the
    // proposal found already in place.
    assert.equal(
      (archiveDb.prepare(`SELECT plex_rating_key AS k FROM media_identity_link WHERE owner_id = ? AND file_record_id = 108`).get(owner) as { k: string }).k,
      "plex-108",
    );
  });

  test("a deselected step is never linked", async () => {
    seedRecords(106, "plex-106");
    seedRecords(107, "plex-107");
    const proposal = await reconcileActions.planReconciliation(owner, {}, reportOf([
      reconciliationRow({
        local: { ...reconciliationRow().local, fileRecordId: 106 },
        plex: { ...reconciliationRow().plex, ratingKey: "plex-106" },
      }),
      reconciliationRow({
        local: { ...reconciliationRow().local, fileRecordId: 107 },
        plex: { ...reconciliationRow().plex, ratingKey: "plex-107" },
      }),
    ]));
    const excluded = proposal.steps.find((step) => step.target.id === "107")!;
    engine.setActionStepSelection(proposal.id, owner, [{ stepId: excluded.id, selected: false }]);
    engine.approveActionProposal(proposal.id, owner);
    await engine.preflightActionProposal(proposal.id, owner);
    await engine.executeActionProposal(proposal.id, owner, true, undefined, { postflight: false });

    assert.equal(
      archiveDb.prepare(`SELECT COUNT(*) AS n FROM media_identity_link WHERE owner_id = ? AND file_record_id = 106`).get(owner).n,
      1,
    );
    assert.equal(
      archiveDb.prepare(`SELECT COUNT(*) AS n FROM media_identity_link WHERE owner_id = ? AND file_record_id = 107`).get(owner).n,
      0,
    );
  });

  test("reports revert availability as engine state, not as a guess from status", async () => {
    seedRecords(109, "plex-109");
    const proposal = await reconcileActions.planReconciliation(owner, {}, reportOf([
      reconciliationRow({
        local: { ...reconciliationRow().local, fileRecordId: 109 },
        plex: { ...reconciliationRow().plex, ratingKey: "plex-109" },
      }),
    ]));

    // Declared truth is available from the very first read, before anything ran.
    assert.equal(proposal.reversibility.kind, "reversible");
    // But nothing has been applied, so there is nothing to undo yet.
    assert.equal(proposal.reversibility.available, false);
    assert.equal(proposal.reversibility.revertableSteps, 0);
    assert.match(String(proposal.reversibility.blockedReason), /nothing to undo/i);

    engine.approveActionProposal(proposal.id, owner);
    await engine.preflightActionProposal(proposal.id, owner);
    // Approval and a passing preflight still change nothing on their own.
    assert.equal(engine.requireActionProposal(proposal.id, owner).reversibility.available, false);

    await engine.executeActionProposal(proposal.id, owner, true, undefined, { postflight: false });
    const executed = engine.requireActionProposal(proposal.id, owner);
    assert.equal(executed.reversibility.available, true);
    assert.equal(executed.reversibility.revertableSteps, 1);
    assert.equal(executed.reversibility.blockedReason, null);

    await engine.revertActionProposal(proposal.id, owner, true);
    const reverted = engine.requireActionProposal(proposal.id, owner);
    // Once reverted there are no completed steps left, so the offer withdraws.
    assert.equal(reverted.reversibility.available, false);
    assert.match(String(reverted.reversibility.blockedReason), /no applied changes/i);
  });
});
