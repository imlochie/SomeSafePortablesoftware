import assert from "node:assert/strict";
import test from "node:test";
import { addPowerRenameCompanions, buildPowerRenamePlan } from "../src/services/power-renamer";

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

test("collision-safe cycles avoid occupied temporary paths", () => {
  const plan = buildPowerRenamePlan([
    { fileRecordId: 10, sourcePath: "/archive/A.mkv", proposedPath: "/archive/B.mkv", confidence: "high", operation: "rename", collision: false, mediaType: "tv", researchGrade: "corroborated" },
    { fileRecordId: 11, sourcePath: "/archive/B.mkv", proposedPath: "/archive/A.mkv", confidence: "high", operation: "rename", collision: false, mediaType: "tv", researchGrade: "corroborated" },
  ], ["/archive/A.mkv", "/archive/B.mkv", "/archive/A.mkv.archive-assistant-tmp-0"]);
  assert.equal(plan.steps[0].to, "/archive/A.mkv.archive-assistant-tmp-1");
  assert.notEqual(plan.steps[0].to.toLowerCase(), plan.steps[1].to.toLowerCase());
});

test("Power Renamer carries exact-match sidecars with the approved video rename", () => {
  const plan = buildPowerRenamePlan([{ fileRecordId: 5, sourcePath: "/archive/Show - S01E01.mkv", proposedPath: "/archive/Show/Season 01/Show - S01E01 - Pilot.mkv", confidence: "high", operation: "restructure", collision: false, mediaType: "tv", researchGrade: "corroborated" }]);
  const expanded = addPowerRenameCompanions(plan, [{ id: 6, path: "/archive/Show - S01E01.srt" }, { id: 7, path: "/archive/Show - S01E01.NFO" }, { id: 8, path: "/archive/Show - S01E01.txt" }]);
  assert.equal(expanded.mappings.length, 3);
  assert.ok(expanded.mappings.some((mapping) => mapping.destinationPath.endsWith("Pilot.srt")));
  assert.ok(expanded.mappings.some((mapping) => mapping.destinationPath.endsWith("Pilot.nfo")));
  assert.ok(!expanded.mappings.some((mapping) => mapping.sourcePath.endsWith(".txt")));
  const blocked = addPowerRenameCompanions(plan, [{ id: 9, path: "/archive/Show - S01E01.srt" }], ["/archive/Show/Season 01/Show - S01E01 - Pilot.srt"]);
  assert.ok(blocked.skipped.some((item) => item.reason.includes("occupied")));
});

test("Power Renamer handles Windows sidecar paths without POSIX basename errors", () => {
  const plan = buildPowerRenamePlan([{ fileRecordId: 12, sourcePath: "D:\\Shows\\Episode S01E01.mkv", proposedPath: "D:\\Shows\\Season 01\\Episode S01E01.mkv", confidence: "high", operation: "rename", collision: false, mediaType: "tv", researchGrade: "corroborated" }]);
  const expanded = addPowerRenameCompanions(plan, [{ id: 13, path: "D:\\Shows\\Episode S01E01.NFO" }]);
  assert.equal(expanded.mappings.length, 2);
  assert.equal(expanded.mappings[1].destinationPath, "D:\\Shows\\Season 01\\Episode S01E01.nfo");
  assert.equal(expanded.steps.some((step) => step.to.includes("Season 01")), true);
});

test("Power Renamer normalizes drive-letter paths with forward slashes", () => {
  const plan = buildPowerRenamePlan([{ fileRecordId: 16, sourcePath: "D:/Shows/Episode.mkv", proposedPath: "D:/Shows/Season 01/Episode.mkv", confidence: "high", operation: "rename", collision: false, mediaType: "tv", researchGrade: "corroborated" }]);
  const expanded = addPowerRenameCompanions(plan, [{ id: 17, path: "d:/shows/Episode.NFO" }]);
  assert.equal(expanded.mappings.length, 2);
  assert.equal(expanded.mappings[1].destinationPath, "D:\\Shows\\Season 01\\Episode.nfo");
});

test("Power Renamer preserves POSIX case-sensitive sidecar directories", () => {
  const plan = buildPowerRenamePlan([{ fileRecordId: 14, sourcePath: "/archive/Shows/Episode.mkv", proposedPath: "/archive/Shows/Renamed/Episode.mkv", confidence: "high", operation: "rename", collision: false, mediaType: "tv", researchGrade: "corroborated" }]);
  const expanded = addPowerRenameCompanions(plan, [{ id: 15, path: "/archive/shows/Episode.srt" }]);
  assert.equal(expanded.mappings.length, 1);
});

test("Power Renamer excludes collisions and uncertain proposals", () => {
  const plan = buildPowerRenamePlan([
    { fileRecordId: 3, sourcePath: "/archive/a.mkv", proposedPath: "/archive/existing.mkv", confidence: "high", operation: "rename", collision: true, mediaType: "tv" },
    { fileRecordId: 4, sourcePath: "/archive/b.mkv", proposedPath: null, confidence: "uncertain", operation: "uncertain/no_action", collision: false, mediaType: "tv" },
  ]);
  assert.equal(plan.mappings.length, 0);
  assert.equal(plan.skipped.length, 2);
});
