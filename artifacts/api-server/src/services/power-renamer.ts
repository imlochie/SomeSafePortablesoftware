import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { buildCollisionSafeRenamePlan, type RenameMapping } from "./rename-plan";

function pathTools(path: string) {
  return path.includes("\\") ? win32 : posix;
}

function pathBasename(path: string) { return pathTools(path).basename(path); }
function pathDirname(path: string) { return pathTools(path).dirname(path); }
function pathExtname(path: string) { return pathTools(path).extname(path); }
function pathJoin(directory: string, filename: string) { return pathTools(directory).join(directory, filename); }

export type PowerRenameCandidate = {
  fileRecordId: number;
  sourcePath: string;
  proposedPath: string | null;
  confidence: string;
  operation: string;
  collision: boolean;
  mediaType: string;
  sourceIdentity?: string;
  researchGrade?: string;
  researchSources?: string[];
  researchBlockers?: string[];
  evidence?: string[];
};

export type PowerRenamePlan = {
  planId: string;
  mode: "supervised";
  mappings: RenameMapping[];
  expectedSourceIdentities: Record<string, string>;
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
    if (candidate.researchGrade !== "corroborated") { skipped.push({ fileRecordId: candidate.fileRecordId, sourcePath: candidate.sourcePath, reason: `Research gate is ${candidate.researchGrade ?? "unknown"}; independent corroboration is required.` }); return false; }
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
  const expectedSourceIdentities = Object.fromEntries(eligible.filter((candidate) => candidate.sourceIdentity).map((candidate) => [candidate.sourcePath, candidate.sourceIdentity!]));
  const planBody = { mappings, expectedSourceIdentities, skipped };
  const planId = `power-renamer-${createHash("sha256").update(JSON.stringify(planBody)).digest("hex").slice(0, 24)}`;
  return {
    planId,
    mode: "supervised",
    mappings,
    expectedSourceIdentities,
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

export type CompanionRecord = { id: number; path: string; identity?: string };

/** Add matching sidecars without guessing unrelated files. A sidecar must share
 * the exact video stem and use a known metadata/subtitle/artwork extension. */
export function addPowerRenameCompanions(plan: PowerRenamePlan, records: CompanionRecord[], occupiedPaths: Iterable<string> = []): PowerRenamePlan {
  const sidecarExtensions = new Set([".srt", ".vtt", ".ass", ".ssa", ".sub", ".idx", ".nfo", ".jpg", ".jpeg", ".png", ".webp"]);
  const additions: RenameMapping[] = [];
  for (const mapping of plan.mappings) {
    const sourceExtension = pathExtname(mapping.sourcePath);
    const destinationExtension = pathExtname(mapping.destinationPath);
    const sourceBase = pathBasename(mapping.sourcePath).slice(0, -sourceExtension.length);
    const destinationBase = pathBasename(mapping.destinationPath).slice(0, -destinationExtension.length);
    for (const record of records) {
      const sameDirectory = pathDirname(record.path).replaceAll("\\", "/").toLowerCase() === pathDirname(mapping.sourcePath).replaceAll("\\", "/").toLowerCase();
      if (record.path === mapping.sourcePath || !sameDirectory) continue;
      const rawExtension = pathExtname(record.path);
      const extension = rawExtension.toLowerCase();
      const recordBase = pathBasename(record.path).slice(0, -rawExtension.length);
      if (!sidecarExtensions.has(extension) || recordBase !== sourceBase) continue;
      additions.push({ id: `companion-${record.id}`, sourcePath: record.path, destinationPath: pathJoin(pathDirname(mapping.destinationPath), `${destinationBase}${extension}`) });
    }
  }
  if (!additions.length) return plan;
  const expectedSourceIdentities = { ...plan.expectedSourceIdentities };
  for (const record of records) if (additions.some((mapping) => mapping.sourcePath === record.path) && record.identity) expectedSourceIdentities[record.path] = record.identity;
  const mappings = [...plan.mappings, ...additions];
  const collisionSafe = buildCollisionSafeRenamePlan(mappings, occupiedPaths);
  if (collisionSafe.errors.length) return { ...plan, skipped: [...plan.skipped, ...collisionSafe.errors.map((reason) => ({ fileRecordId: 0, sourcePath: "", reason }))] };
  return { ...plan, mappings, expectedSourceIdentities, steps: collisionSafe.steps, planId: `${plan.planId}-with-companions` };
}

export function powerRenameSummary(plan: PowerRenamePlan) {
  return {
    planId: plan.planId,
    files: plan.mappings.length,
    filesystemSteps: plan.steps.length,
    skipped: plan.skipped.length,
    foldersAffected: new Set(plan.mappings.map((mapping) => pathDirname(mapping.destinationPath))).size,
    examples: plan.mappings.slice(0, 5).map((mapping) => ({ from: pathBasename(mapping.sourcePath), to: pathBasename(mapping.destinationPath) })),
  };
}
