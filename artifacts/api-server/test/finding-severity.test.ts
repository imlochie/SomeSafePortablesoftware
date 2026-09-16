import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  atLeast,
  classifyFinding,
  compareSeverity,
  findingSeverities,
  summariseSeverity,
  type FindingInput,
  type FindingQualityStatus,
} from "../src/services/finding-severity";

/**
 * These tests are the severity policy. The classifier decides what reaches a
 * person, so the intent of each rule is asserted here rather than left to the
 * reading of a switch statement.
 */

function finding(overrides: Partial<FindingInput> & { qualityStatus: FindingQualityStatus }): FindingInput {
  return { ...overrides };
}

describe("finding severity classification", () => {
  test("a missing only copy is critical and always reaches the operator", () => {
    const result = classifyFinding(finding({ qualityStatus: "file_missing", onlyCopy: true }));
    assert.equal(result.severity, "critical");
    assert.equal(result.confidence, "certain");
    assert.equal(result.reviewRequired, true);
    assert.match(result.reason, /only known copy/i);
  });

  test("a missing file with another copy is high rather than critical", () => {
    const result = classifyFinding(finding({ qualityStatus: "file_missing", onlyCopy: false }));
    assert.equal(result.severity, "high");
    assert.equal(result.reviewRequired, true);
  });

  test("a corrupt container is high because it may be data loss", () => {
    const result = classifyFinding(finding({
      qualityStatus: "needs_review",
      integrityClassification: "corrupt_or_malformed_container",
    }));
    assert.equal(result.severity, "high");
    assert.equal(result.reviewRequired, true);
    assert.match(result.reason, /corrupt or malformed/i);
  });

  test("an unavailable inspection is a tooling problem, not a media finding", () => {
    // This must not reach the operator: it says nothing about the file.
    const result = classifyFinding(finding({
      qualityStatus: "needs_review",
      integrityClassification: "inspection_unavailable",
    }));
    assert.equal(result.severity, "low");
    assert.equal(result.reviewRequired, false);
    assert.match(result.reason, /operational error/i);
  });

  test("a material resolution-versus-HDR tradeoff needs a human decision", () => {
    const result = classifyFinding(finding({
      qualityStatus: "needs_review",
      qualityDifferences: ["resolution 2160p vs 1080p", "SDR vs HDR"],
    }));
    assert.equal(result.severity, "medium");
    assert.equal(result.reviewRequired, true);
  });

  test("an exact checksum duplicate is certain and reviewable", () => {
    const result = classifyFinding(finding({
      qualityStatus: "duplicate",
      checksum: "abc",
      duplicateChecksum: "abc",
      duplicateOfId: 9,
    }));
    assert.equal(result.severity, "medium");
    assert.equal(result.confidence, "certain");
    assert.equal(result.reviewRequired, true);
    assert.match(result.reason, /identical sha-256/i);
  });

  test("a fingerprint-only duplicate is likely, not certain, and stays informational", () => {
    // Same title, runtime and codecs can legitimately be two different encodes.
    const result = classifyFinding(finding({
      qualityStatus: "duplicate",
      checksum: "abc",
      duplicateChecksum: "def",
      fingerprint: "fp",
      duplicateOfId: 9,
    }));
    assert.equal(result.severity, "low");
    assert.equal(result.confidence, "likely");
    assert.equal(result.reviewRequired, false);
  });

  test("a duplicate with no counterpart checksum is not treated as exact", () => {
    const result = classifyFinding(finding({
      qualityStatus: "duplicate",
      checksum: "abc",
      duplicateOfId: 9,
    }));
    assert.equal(result.confidence, "likely");
    assert.equal(result.reviewRequired, false);
  });

  test("a lower-quality version with stated differences is a real decision", () => {
    const result = classifyFinding(finding({
      qualityStatus: "lower_quality_version",
      qualityDifferences: ["resolution 1080p vs 2160p"],
    }));
    assert.equal(result.severity, "medium");
    assert.equal(result.reviewRequired, true);
    assert.match(result.reason, /resolution 1080p vs 2160p/);
  });

  test("a lower-quality version with no stated differences is not actionable", () => {
    const result = classifyFinding(finding({
      qualityStatus: "lower_quality_version",
      qualityDifferences: [],
    }));
    assert.equal(result.severity, "low");
    assert.equal(result.reviewRequired, false);
  });

  test("higher_quality_available is informational and never a review item", () => {
    // This single rule is the primary correction: it was the largest source of
    // review-queue inflation, and it is good news about the archive.
    for (const qualityDifferences of [[], ["resolution 2160p vs 1080p"], ["HDR vs SDR", "bitrate 90 vs 40"]]) {
      const result = classifyFinding(finding({
        qualityStatus: "higher_quality_available",
        qualityDifferences,
      }));
      assert.equal(result.severity, "info");
      assert.equal(result.confidence, "observation");
      assert.equal(result.reviewRequired, false, "a better local file is not an operator task");
    }
  });

  test("steady-state statuses are informational", () => {
    for (const qualityStatus of ["best_local_version", "plex_version_exists", "local_only"] as const) {
      const result = classifyFinding(finding({ qualityStatus }));
      assert.equal(result.severity, "info", qualityStatus);
      assert.equal(result.reviewRequired, false, qualityStatus);
    }
  });

  test("every quality status is classified explicitly", () => {
    // A new status must not silently fall through to a default.
    const statuses: FindingQualityStatus[] = [
      "best_local_version",
      "lower_quality_version",
      "higher_quality_available",
      "duplicate",
      "plex_version_exists",
      "local_only",
      "file_missing",
      "needs_review",
    ];
    for (const qualityStatus of statuses) {
      const result = classifyFinding(finding({ qualityStatus }));
      assert.ok(findingSeverities.includes(result.severity), qualityStatus);
      assert.ok(result.reason.length > 0, `${qualityStatus} must explain itself`);
    }
  });

  test("only findings that need a decision are marked review required", () => {
    const reviewable = ([
      { qualityStatus: "file_missing", onlyCopy: true },
      { qualityStatus: "file_missing" },
      { qualityStatus: "needs_review", integrityClassification: "corrupt_or_malformed_container" },
      { qualityStatus: "needs_review" },
      { qualityStatus: "duplicate", checksum: "a", duplicateChecksum: "a" },
      { qualityStatus: "lower_quality_version", qualityDifferences: ["resolution"] },
    ] as FindingInput[]).map((input) => classifyFinding(input).reviewRequired);
    assert.deepEqual(reviewable, [true, true, true, true, true, true]);

    const informational = ([
      { qualityStatus: "higher_quality_available" },
      { qualityStatus: "best_local_version" },
      { qualityStatus: "plex_version_exists" },
      { qualityStatus: "local_only" },
      { qualityStatus: "duplicate", checksum: "a", duplicateChecksum: "b" },
      { qualityStatus: "lower_quality_version" },
      { qualityStatus: "needs_review", integrityClassification: "inspection_unavailable" },
    ] as FindingInput[]).map((input) => classifyFinding(input).reviewRequired);
    assert.deepEqual(informational, [false, false, false, false, false, false, false]);
  });

  test("severities order from info to critical", () => {
    assert.ok(compareSeverity("critical", "info") > 0);
    assert.ok(compareSeverity("info", "low") < 0);
    assert.equal(compareSeverity("medium", "medium"), 0);
    assert.equal(atLeast("high", "medium"), true);
    assert.equal(atLeast("low", "medium"), false);
    assert.equal(atLeast("medium", "medium"), true);
  });

  test("a breakdown separates decisions from observations", () => {
    const inputs: FindingInput[] = [
      { qualityStatus: "duplicate", checksum: "a", duplicateChecksum: "a" },
      { qualityStatus: "duplicate", checksum: "a", duplicateChecksum: "b" },
      { qualityStatus: "duplicate", checksum: "c", duplicateChecksum: "d" },
      { qualityStatus: "higher_quality_available" },
      { qualityStatus: "file_missing", onlyCopy: true },
    ];
    const breakdown = summariseSeverity(inputs.map(classifyFinding));
    assert.equal(breakdown.total, 5);
    assert.equal(breakdown.reviewRequired, 2);
    assert.equal(breakdown.informational, 3);
    assert.equal(breakdown.bySeverity.critical, 1);
    assert.equal(breakdown.bySeverity.medium, 1);
    assert.equal(breakdown.bySeverity.low, 2);
    assert.equal(breakdown.bySeverity.info, 1);
    assert.equal(breakdown.bySeverity.high, 0);
  });

  test("classification is pure and stable across repeated calls", () => {
    const input = finding({
      qualityStatus: "duplicate",
      checksum: "same",
      duplicateChecksum: "same",
    });
    assert.deepEqual(classifyFinding(input), classifyFinding(input));
  });
});
