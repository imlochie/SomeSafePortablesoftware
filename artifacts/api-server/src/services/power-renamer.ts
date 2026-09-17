import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { buildCollisionSafeRenamePlan, type RenameMapping } from "./rename-plan";

export type PowerRenameCandidate = {
  fileRecordId: number;
  sourcePath: string;
  proposedPath: string | null;
  confidence: string;
  operation: string;
  collision: boolean;
  mediaType: string;
  evidence?: string[];
};

export type PowerRenamePlan = {
  planId: string;
  mode: "supervised";
  mappings: RenameMapping[];
  steps: ReturnType<typeof buildCollisionSafeRenamePlan>["steps"];
  skipped: Array<{ fileRecordId: number; sourcePath: string; reason: string }>;
  safeguards: string[];
};

/**
 * The supervised core of Power Renamer. It is deliberately deterministic and
 * has no filesystem side effects: the caller must put the returned plan behind
 * review, preflight, confirmation, and the normal reversible operation path.
 */
export function buildPowerRenamePlan(candidates: PowerRenameCandidate[], occupiedPaths: Iterable<string> = []): PowerRenamePlan {
  const skipped: PowerRenamePlan["skipped"] = [];
  const eligible = candidates.filter((candidate) => {
    if (!candidate.proposedPath) { skipped.push({ fileRecordId: candidate.fileRecordId, sourcePath: candidate.sourcePath, reason: "No executable destination was proposed." }); return false; }
    if (candidate.operation === "uncertain/no_action" || candidate.collision) { skipped.push({ fileRecordId: candidate.fileRecordId, sourcePath: candidate.sourcePath, reason: candidate.collision ? "Destination collision requires manual resolution." : "Naming evidence is uncertain." }); return false; }
    if (candidate.sourcePath === candidate.proposedPath) { skipped.push({ fileRecordId: candidate.fileRecordId, sourcePath: candidate.sourcePath, reason: "Source and destination are identical." }); return false; }
    return true;
  });
  const mappings: RenameMapping[] = eligible.map((candidate) => ({
    id: `record-${candidate.fileRecordId}`,
    sourcePath: candidate.sourcePath,
    destinationPath: candidate.proposedPath!,
  }));
  const collisionSafe = buildCollisionSafeRenamePlan(mappings, occupiedPaths);
  for (const error of collisionSafe.errors) skipped.push({ fileRecordId: Number(error.match(/record-(\d+)/)?.[1] ?? 0), sourcePath: "", reason: error });
  const planBody = { mappings, skipped };
  const planId = `power-renamer-${createHash("sha256").update(JSON.stringify(planBody)).digest("hex").slice(0, 24)}`;
  return {
    planId,
    mode: "supervised",
    mappings,
    steps: collisionSafe.steps,
    skipped,
    safeguards: [
      "Only explicitly selected, executable proposals are included.",
      "No overwrite: unrelated destination occupants are rejected.",
      "Cycles use temporary sibling names and are collision-safe.",
      "Approval, preflight, explicit execution confirmation, verification, and rollback remain mandatory.",
      "Video contents, Plex metadata, and files outside this plan are not changed.",
    ],
  };
}

export function powerRenameSummary(plan: PowerRenamePlan) {
  return {
    planId: plan.planId,
    files: plan.mappings.length,
    filesystemSteps: plan.steps.length,
    skipped: plan.skipped.length,
    foldersAffected: new Set(plan.mappings.map((mapping) => dirname(mapping.destinationPath))).size,
    examples: plan.mappings.slice(0, 5).map((mapping) => ({ from: basename(mapping.sourcePath), to: basename(mapping.destinationPath) })),
  };
}
