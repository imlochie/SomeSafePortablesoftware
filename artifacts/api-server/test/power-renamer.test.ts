import assert from "node:assert/strict";
import test from "node:test";
import { buildPowerRenamePlan } from "../src/services/power-renamer";

test("Power Renamer builds a supervised collision-safe cycle plan", () => {
  const plan = buildPowerRenamePlan([
    { fileRecordId: 1, sourcePath: "/archive/A.mkv", proposedPath: "/archive/B.mkv", confidence: "high", operation: "rename", collision: false, mediaType: "tv", researchGrade: "corroborated" },
    { fileRecordId: 2, sourcePath: "/archive/B.mkv", proposedPath: "/archive/A.mkv", confidence: "high", operation: "rename", collision: false, mediaType: "tv", researchGrade: "corroborated" },
  ], ["/archive/A.mkv", "/archive/B.mkv"]);
  assert.equal(plan.mode, "supervised");
  assert.equal(plan.mappings.length, 2);
  assert.equal(plan.steps.filter((step) => step.temporary).length, 2);
  assert.match(plan.safeguards.join(" "), /Approval/);
});

test("Power Renamer excludes collisions and uncertain proposals", () => {
  const plan = buildPowerRenamePlan([
    { fileRecordId: 3, sourcePath: "/archive/a.mkv", proposedPath: "/archive/existing.mkv", confidence: "high", operation: "rename", collision: true, mediaType: "tv" },
    { fileRecordId: 4, sourcePath: "/archive/b.mkv", proposedPath: null, confidence: "uncertain", operation: "uncertain/no_action", collision: false, mediaType: "tv" },
  ]);
  assert.equal(plan.mappings.length, 0);
  assert.equal(plan.skipped.length, 2);
});
