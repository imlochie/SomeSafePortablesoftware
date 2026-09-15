import type { MediaIntegrityClassification } from "./media-integrity";

// ---------------------------------------------------------------------------
// Finding severity classification
//
// The archive was conflating "the system noticed something" with "the operator
// must decide something". Every reviewable quality status produced a review
// item, including higher_quality_available, which means the local file ranks
// HIGHER than the provider copy. That is archive intelligence, not a task.
//
// This module is the single place that decides how important a finding is and
// whether it belongs in front of a person. Every screen and service must ask
// classifyFinding rather than inventing its own interpretation, otherwise the
// review queue, the overview and the assistant will disagree about the same
// file.
//
// It is deliberately a pure function of an explicit input shape: no database,
// no clock, no configuration. That makes the policy testable in isolation and
// keeps the classification identical wherever it is asked.
// ---------------------------------------------------------------------------

/**
 * Ordered from least to most operationally important. The order is load
 * bearing: compareSeverity and atLeast rely on the index.
 */
export const findingSeverities = ["info", "low", "medium", "high", "critical"] as const;

export type FindingSeverity = (typeof findingSeverities)[number];

/**
 * The quality statuses produced by archive intelligence. Mirrors QualityStatus
 * in services/archive.ts, which is not exported.
 */
export type FindingQualityStatus =
  | "best_local_version"
  | "lower_quality_version"
  | "higher_quality_available"
  | "duplicate"
  | "plex_version_exists"
  | "local_only"
  | "file_missing"
  | "needs_review";

export interface FindingInput {
  qualityStatus: FindingQualityStatus;
  /** SHA-256 of the file, when one was computed. */
  checksum?: string | null;
  /** Normalised title/duration/codec fingerprint, when one was computed. */
  fingerprint?: string | null;
  /** The other local record this one duplicates, when known. */
  duplicateOfId?: number | null;
  /** The checksum of the duplicate counterpart, when known. */
  duplicateChecksum?: string | null;
  /** Human-readable quality deltas against the compared version. */
  qualityDifferences?: string[];
  /** Set when FFprobe could not read the file. */
  integrityClassification?: MediaIntegrityClassification | null;
  /** True when the file is the only copy of its media identity. */
  onlyCopy?: boolean;
}

export type FindingConfidence = "certain" | "likely" | "needs_verification" | "observation";

export interface FindingClassification {
  severity: FindingSeverity;
  confidence: FindingConfidence;
  /**
   * Whether this finding should be placed in front of the operator as a
   * decision. Informational findings remain queryable and are still counted;
   * they simply do not become review items.
   */
  reviewRequired: boolean;
  /** Why this severity was chosen, in the operator's language. */
  reason: string;
}

export function compareSeverity(left: FindingSeverity, right: FindingSeverity): number {
  return findingSeverities.indexOf(left) - findingSeverities.indexOf(right);
}

export function atLeast(severity: FindingSeverity, minimum: FindingSeverity): boolean {
  return compareSeverity(severity, minimum) >= 0;
}

/**
 * Classifies a single archive finding.
 *
 * The policy is deliberately conservative: a finding is only escalated to
 * review when there is a decision a person actually has to make. When in
 * doubt, prefer a lower severity and leave the evidence queryable — an
 * under-escalated finding is an annoyance, while an over-escalated one buries
 * the genuine problems under tens of thousands of rows, which is the failure
 * this module exists to correct.
 */
export function classifyFinding(input: FindingInput): FindingClassification {
  const differences = input.qualityDifferences ?? [];

  switch (input.qualityStatus) {
    /**
     * A file that vanished between scans. This is the loss case: the archive
     * believed it held something and no longer does. Losing the only copy is
     * the single most serious thing this system can report.
     */
    case "file_missing":
      return input.onlyCopy === true
        ? {
          severity: "critical",
          confidence: "certain",
          reviewRequired: true,
          reason: "The only known copy of this media is no longer present in the archive.",
        }
        : {
          severity: "high",
          confidence: "certain",
          reviewRequired: true,
          reason: "The file was not present during the latest completed scan.",
        };

    /**
     * FFprobe could not read the file. A corrupt container is possible data
     * loss and is escalated. An inspection that merely failed to run is an
     * operational problem with the tooling, not evidence about the media, so
     * it stays low and does not become a decision.
     */
    case "needs_review":
      if (input.integrityClassification === "corrupt_or_malformed_container") {
        return {
          severity: "high",
          confidence: "likely",
          reviewRequired: true,
          reason: "FFprobe reported a corrupt or malformed container, which may indicate data loss.",
        };
      }
      if (input.integrityClassification === "inspection_unavailable") {
        return {
          severity: "low",
          confidence: "needs_verification",
          reason: "The file could not be inspected because of an operational error, not because of its contents.",
          reviewRequired: false,
        };
      }
      return {
        severity: "medium",
        confidence: "needs_verification",
        reviewRequired: true,
        reason: "The local and provider versions make a material tradeoff that needs a human decision.",
      };

    /**
     * Two files hold the same media. Identical checksums are a certain
     * duplicate and worth reclaiming space for. A fingerprint match is only
     * probable — same title, runtime and codecs can legitimately be two
     * different encodes — so it is surfaced but not asserted.
     */
    case "duplicate": {
      const exact = Boolean(
        input.checksum
        && input.duplicateChecksum
        && input.checksum === input.duplicateChecksum,
      );
      return exact
        ? {
          severity: "medium",
          confidence: "certain",
          reviewRequired: true,
          reason: "An identical SHA-256 checksum was found on another local file.",
        }
        : {
          severity: "low",
          confidence: "likely",
          reviewRequired: false,
          reason: "Another local file shares this media fingerprint, but the bytes differ.",
        };
    }

    /**
     * A better local or provider version exists. This is a genuine quality
     * decision, but only when the system can say what is actually better. With
     * no stated differences there is nothing to decide on.
     */
    case "lower_quality_version":
      return differences.length > 0
        ? {
          severity: "medium",
          confidence: "likely",
          reviewRequired: true,
          reason: `A higher-quality version exists: ${differences.join(", ")}.`,
        }
        : {
          severity: "low",
          confidence: "needs_verification",
          reviewRequired: false,
          reason: "A higher-quality version is indicated, but no specific differences were recorded.",
        };

    /**
     * The local file ranks HIGHER than the provider copy. This was the primary
     * source of review-queue inflation. It is good news about the archive and
     * requires nothing from the operator, so it is informational however many
     * differences were found.
     */
    case "higher_quality_available":
      return {
        severity: "info",
        confidence: "observation",
        reviewRequired: false,
        reason: "The local file ranks higher than the matched provider version. No action is needed.",
      };

    /**
     * Steady-state facts. Present for completeness so that every status has an
     * explicit classification rather than falling through to a default.
     */
    case "best_local_version":
      return {
        severity: "info",
        confidence: "observation",
        reviewRequired: false,
        reason: "This is the highest available local version for its media identity.",
      };

    case "plex_version_exists":
      return {
        severity: "info",
        confidence: "observation",
        reviewRequired: false,
        reason: "A matching provider item exists with equivalent quality metadata.",
      };

    /**
     * Present locally with no provider match. Worth knowing, and often simply
     * means the provider library has not been told about it, so it is not a
     * decision on its own.
     */
    case "local_only":
      return {
        severity: "info",
        confidence: "observation",
        reviewRequired: false,
        reason: "No matching provider item was found for this local file.",
      };
  }
}

export interface SeverityBreakdown {
  total: number;
  reviewRequired: number;
  informational: number;
  bySeverity: Record<FindingSeverity, number>;
}

/**
 * Summarises a set of classifications so a screen can say "309 duplicates, 14
 * require review, 295 informational" instead of an undifferentiated count.
 */
export function summariseSeverity(
  classifications: Iterable<FindingClassification>,
): SeverityBreakdown {
  const bySeverity = Object.fromEntries(
    findingSeverities.map((severity) => [severity, 0]),
  ) as Record<FindingSeverity, number>;
  let total = 0;
  let reviewRequired = 0;
  for (const classification of classifications) {
    total += 1;
    bySeverity[classification.severity] += 1;
    if (classification.reviewRequired) reviewRequired += 1;
  }
  return { total, reviewRequired, informational: total - reviewRequired, bySeverity };
}
