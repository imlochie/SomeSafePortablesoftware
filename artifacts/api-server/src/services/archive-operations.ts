import { promises as fs } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { archiveDb, addEvent, readSettings, type SettingsRecord } from "../lib/archive-db";
import {
  archiveVolumeId,
  localIdentityForPath,
  upsertLocalIdentity,
  invalidateArchiveInventoryCache,
} from "./archive";
import { getArchiveVolumes, isArchivePathWithin, type ArchiveVolume } from "./storage";
import { buildNamingProposals } from "./naming-intelligence";

export const ARCHIVE_OPERATION_KINDS = ["rename", "move", "restructure"] as const;
export type ArchiveOperationKind = (typeof ARCHIVE_OPERATION_KINDS)[number];

export const ARCHIVE_OPERATION_STATUSES = [
  "proposed",
  "approved",
  "queued",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
] as const;
export type ArchiveOperationStatus = (typeof ARCHIVE_OPERATION_STATUSES)[number];

const TRAVERSAL_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/;

export class ArchiveMutationError extends Error {
  readonly code:
    | "invalid_path"
    | "outside_volume"
    | "collision"
    | "source_missing"
    | "source_changed"
    | "symlink"
    | "same_path"
    | "extension_change"
    | "state";

  constructor(code: ArchiveMutationError["code"], message: string) {
    super(message);
    this.name = "ArchiveMutationError";
    this.code = code;
  }
}

type OperationRow = {
  id: number;
  owner_id: string;
  kind: ArchiveOperationKind;
  status: ArchiveOperationStatus;
  source_path: string;
  target_path: string;
  file_record_id: number | null;
  source_evidence_key: string | null;
  proposal_evidence: string;
  expected_size_bytes: number | null;
  expected_modified_at_ms: number | null;
  created_directories: string;
  error: string | null;
  applied_at: string | null;
  rolled_back_at: string | null;
  rollback_available: number;
  created_at: string;
  updated_at: string;
};

function toOperation(row: OperationRow) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    sourcePath: row.source_path,
    targetPath: row.target_path,
    fileRecordId: row.file_record_id,
    sourceEvidenceKey: row.source_evidence_key,
    proposalEvidence: parseJsonRecord(row.proposal_evidence),
    expectedSizeBytes: row.expected_size_bytes,
    expectedModifiedAtMs: row.expected_modified_at_ms,
    createdDirectories: parseJsonArray(row.created_directories),
    error: row.error,
    appliedAt: row.applied_at,
    rolledBackAt: row.rolled_back_at,
    rollbackAvailable: row.status === "succeeded" && row.rollback_available === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function readOperations(ownerId: string, limit = 20) {
  const rows = archiveDb
    .prepare(
      "SELECT * FROM archive_operation WHERE owner_id = ? ORDER BY id DESC LIMIT ?",
    )
    .all(ownerId, Math.max(1, Math.min(100, limit))) as OperationRow[];
  return rows.map(toOperation);
}

export function readOperation(ownerId: string, id: number) {
  const row = archiveDb
    .prepare("SELECT * FROM archive_operation WHERE owner_id = ? AND id = ?")
    .get(ownerId, id) as OperationRow | undefined;
  return row ? toOperation(row) : null;
}

function findVolumeForPath(candidate: string, volumes: ArchiveVolume[]): ArchiveVolume | null {
  return (
    volumes.find((volume) => isArchivePathWithin(candidate, volume.path)) ?? null
  );
}

export type ValidatedMutation = {
  sourcePath: string;
  targetPath: string;
  sourceVolume: ArchiveVolume;
  targetVolume: ArchiveVolume;
};

// Every mutation path must be absolute-after-expansion, traversal-free, and
// contained inside a configured archive volume. This is enforced for both the
// source and the destination, so a journal entry can never escape into an
// arbitrary part of the filesystem.
export function validateMutationPaths(
  sourcePath: string,
  targetPath: string,
  settings: SettingsRecord = readSettings(),
): ValidatedMutation {
  const inputs = [
    { label: "Source", value: sourcePath },
    { label: "Target", value: targetPath },
  ];
  const resolved = inputs.map(({ label, value }) => {
    const candidate = value.trim();
    if (!candidate) throw new ArchiveMutationError("invalid_path", `${label} path is required.`);
    if (TRAVERSAL_SEGMENT.test(candidate)) {
      throw new ArchiveMutationError("invalid_path", `${label} path must not contain traversal segments.`);
    }
    if (!isAbsolute(candidate)) {
      throw new ArchiveMutationError("invalid_path", `${label} path must be absolute.`);
    }
    return resolve(candidate);
  });
  const [source, target] = resolved as [string, string];

  if (source === target || source.toLowerCase() === target.toLowerCase()) {
    throw new ArchiveMutationError("same_path", "Source and target paths are identical; no mutation is needed.");
  }

  if (extname(source).toLowerCase() !== extname(target).toLowerCase()) {
    throw new ArchiveMutationError(
      "extension_change",
      `Renaming media across extensions (${extname(source) || "none"} to ${extname(target) || "none"}) is not permitted.`,
    );
  }

  const volumes = getArchiveVolumes(settings);
  const sourceVolume = findVolumeForPath(source, volumes);
  const targetVolume = findVolumeForPath(target, volumes);
  if (!sourceVolume) {
    throw new ArchiveMutationError("outside_volume", "Source path is not inside a configured archive volume.");
  }
  if (!targetVolume) {
    throw new ArchiveMutationError("outside_volume", "Target path is not inside a configured archive volume.");
  }

  const relativeTarget = relative(resolve(targetVolume.path), target);
  if (!relativeTarget || relativeTarget === ".") {
    throw new ArchiveMutationError("invalid_path", "Target must be a file path inside the archive volume, not the volume root.");
  }
  // The target's parent must also sit inside the volume (implied by target
  // containment for non-empty relative paths, but keep the file itself safe:
  // a bare filename directly in the volume root is allowed).
  if (isArchivePathWithin(source, target)) {
    throw new ArchiveMutationError("invalid_path", "Target path cannot contain the source path.");
  }

  return { sourcePath: source, targetPath: target, sourceVolume, targetVolume };
}

// Creates missing directories under the target and reports which directories
// were actually created so rollback can remove them again.
async function ensureTargetDirectory(targetPath: string, volumeRoot: string): Promise<string[]> {
  const root = resolve(volumeRoot);
  const created: string[] = [];
  let parent = dirname(targetPath);
  const chain: string[] = [];
  // Walk from the target's directory up to (but not including) the volume
  // root, collecting directories that do not exist yet.
  while (parent !== root && isArchivePathWithin(parent, root)) {
    try {
      const stat = await fs.lstat(parent);
      if (stat.isDirectory()) break;
      if (stat.isSymbolicLink()) {
        throw new ArchiveMutationError("symlink", `Target parent directory is a symlink: ${parent}`);
      }
      throw new ArchiveMutationError("invalid_path", `Target parent is not a directory: ${parent}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      chain.push(parent);
      parent = dirname(parent);
    }
  }
  for (const directory of chain.reverse()) {
    await fs.mkdir(directory, { recursive: true });
    created.push(directory);
  }
  return created;
}

async function removeEmptyDirectories(directories: string[]) {
  for (const directory of directories.slice().reverse()) {
    try {
      await fs.rmdir(directory);
    } catch {
      // Directory vanished, became non-empty, or is unavailable: leaving it
      // behind is safer than any cleanup attempt.
    }
  }
}

function setOperationState(id: number, ownerId: string, status: ArchiveOperationStatus, updates: Record<string, unknown> = {}) {
  const entries = Object.entries(updates);
  const assignments = ["status = ?", ...entries.map(([key]) => `${key} = ?`), "updated_at = CURRENT_TIMESTAMP"].join(", ");
  archiveDb
    .prepare(`UPDATE archive_operation SET ${assignments} WHERE id = ? AND owner_id = ?`)
    .run(status, ...entries.map(([, value]) => value as string | number | null), id, ownerId);
}

// Post-rename inventory relocation: the media content is unchanged, so probe
// fields, checksum, size, and mtime are preserved; only path-derived fields
// and the local identity are recomputed from the stored values.
function relocateArchiveRecord(
  ownerId: string,
  currentPath: string,
  destinationPath: string,
): { fileRecordId: number | null } {
  const row = archiveDb
    .prepare(
      `SELECT id, archive_root, size_bytes, checksum, duration_seconds, width, height, video_codec, audio_codec
       FROM file_record WHERE owner_id = ? AND path = ?`,
    )
    .get(ownerId, currentPath) as {
      id: number;
      archive_root: string | null;
      size_bytes: number | null;
      checksum: string | null;
      duration_seconds: number | null;
      width: number | null;
      height: number | null;
      video_codec: string | null;
      audio_codec: string | null;
    } | undefined;
  if (!row) return { fileRecordId: null };

  const newFilename = basename(destinationPath);
  // Keep the scanned root the file was recorded under; identity and relative
  // paths stay consistent with how the scan itself stores them.
  const rootPath = row.archive_root ?? findVolumeRoot(ownerId, destinationPath);
  // The media fingerprint starts with the normalized title, which follows the
  // filename; rebuild it from the stored probe values without re-inspecting.
  const hasProbeEvidence = row.duration_seconds !== null || row.width !== null || row.height !== null || row.video_codec !== null || row.audio_codec !== null;
  const fingerprint = hasProbeEvidence
    ? [
      normalizeTitleSegment(newFilename),
      row.duration_seconds === null ? "unknown" : Math.round(row.duration_seconds),
      row.width ?? "unknown",
      row.height ?? "unknown",
      row.video_codec ?? "unknown",
      row.audio_codec ?? "unknown",
    ].join("|")
    : null;
  const identity = localIdentityForPath(
    newFilename,
    rootPath,
    row.size_bytes,
    fingerprint,
    row.checksum,
  );
  const identityId = upsertLocalIdentity(ownerId, identity);

  archiveDb
    .prepare(
      `UPDATE file_record
       SET path = ?, filename = ?, relative_path = ?, archive_root = ?, volume_id = ?,
           local_identity_id = ?, fingerprint = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND owner_id = ?`,
    )
    .run(
      destinationPath,
      newFilename,
      relative(rootPath, destinationPath),
      rootPath,
      archiveVolumeId(rootPath),
      identityId,
      fingerprint,
      row.id,
      ownerId,
    );

  archiveDb
    .prepare(
      "UPDATE archive_item SET title = ?, archive_path = ?, updated_at = CURRENT_TIMESTAMP WHERE owner_id = ? AND archive_path = ?",
    )
    .run(newFilename.replace(/\.[^.]+$/, ""), destinationPath, ownerId, currentPath);

  return { fileRecordId: row.id };
}

function normalizeTitleSegment(filename: string) {
  // Mirrors archive.ts normalizeTitle's title-first fingerprint component.
  const normalized = filename
    .replace(/\.[^.]+$/, "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/\b(4k|uhd|2160p?|1080p?|720p?|480p?|bluray|web[ ._-]?dl|x26[45]|h26[45]|hevc|av1)\b/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized || filename.replace(/\.[^.]+$/, "");
}

// file_record.archive_root stores the volume root the scan walked; for a
// relocated file the containing volume root wins over the derived directory.
function findVolumeRoot(ownerId: string, filePath: string): string {
  const volumes = getArchiveVolumes(readSettings());
  const volume = findVolumeForPath(filePath, volumes);
  return volume?.path ?? dirname(filePath);
}

export type DryRunCheck = { step: string; ok: boolean; message: string };

export type OperationPlan = {
  ok: boolean;
  checks: DryRunCheck[];
  sourcePath: string | null;
  targetPath: string | null;
  error: string | null;
};

// Full simulation of the mutation: every check that executeOperation performs
// before touching the filesystem, with zero writes.
export async function dryRunMutation(
  sourcePath: string,
  targetPath: string,
  ownerId: string,
  settings: SettingsRecord = readSettings(),
  expected: { sizeBytes?: number | null; modifiedAtMs?: number | null } = {},
): Promise<OperationPlan> {
  const checks: DryRunCheck[] = [];
  let paths: ValidatedMutation | null = null;
  try {
    paths = validateMutationPaths(sourcePath, targetPath, settings);
    checks.push({ step: "path_safety", ok: true, message: "Source and target are absolute, traversal-free, and inside configured archive volumes." });
  } catch (error) {
    checks.push({ step: "path_safety", ok: false, message: error instanceof Error ? error.message : "Path validation failed." });
    return { ok: false, checks, sourcePath: null, targetPath: null, error: checks[0].message };
  }

  try {
    const stat = await fs.lstat(paths.sourcePath);
    if (stat.isSymbolicLink()) {
      throw new ArchiveMutationError("symlink", "Source is a symlink; only regular files are relocated.");
    }
    if (!stat.isFile()) {
      throw new ArchiveMutationError("source_missing", "Source path is not a regular file.");
    }
    if (expected.sizeBytes != null && stat.size !== expected.sizeBytes) {
      throw new ArchiveMutationError("source_changed", `Source size changed since the proposal (${expected.sizeBytes} -> ${stat.size} bytes).`);
    }
    if (expected.modifiedAtMs != null && Math.trunc(stat.mtimeMs) !== Math.trunc(expected.modifiedAtMs)) {
      throw new ArchiveMutationError("source_changed", "Source modification time changed since the proposal.");
    }
    checks.push({ step: "source", ok: true, message: `Source exists as a regular file (${stat.size} bytes).` });
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? `Source file does not exist: ${paths.sourcePath}`
      : error instanceof Error ? error.message : "Source could not be inspected.";
    checks.push({ step: "source", ok: false, message });
    return { ok: false, checks, sourcePath: paths.sourcePath, targetPath: paths.targetPath, error: message };
  }

  try {
    const targetStat = await fs.lstat(paths.targetPath);
    void targetStat;
    throw new ArchiveMutationError("collision", `Target already exists and would not be overwritten: ${paths.targetPath}`);
  } catch (error) {
    if (error instanceof ArchiveMutationError) {
      checks.push({ step: "collision", ok: false, message: error.message });
      return { ok: false, checks, sourcePath: paths.sourcePath, targetPath: paths.targetPath, error: error.message };
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : "Target availability could not be verified.";
      checks.push({ step: "collision", ok: false, message });
      return { ok: false, checks, sourcePath: paths.sourcePath, targetPath: paths.targetPath, error: message };
    }
    checks.push({ step: "collision", ok: true, message: "Target path is free; no overwrite is required." });
  }

  checks.push({ step: "directories", ok: true, message: "Missing parent directories would be created inside the target volume and recorded for rollback." });
  return { ok: true, checks, sourcePath: paths.sourcePath, targetPath: paths.targetPath, error: null };
}

export type CreateOperationInput = {
  kind: ArchiveOperationKind;
  sourcePath: string;
  targetPath: string;
  fileRecordId: number | null;
  sourceEvidenceKey: string | null;
  proposalEvidence: Record<string, unknown>;
  expectedSizeBytes: number | null;
  expectedModifiedAtMs: number | null;
  initialStatus?: Extract<ArchiveOperationStatus, "proposed" | "approved" | "queued">;
};

export function createOperation(ownerId: string, input: CreateOperationInput, settings: SettingsRecord = readSettings()) {
  // Creation validates and normalizes the paths before anything is persisted,
  // so the journal only ever contains confined absolute destinations.
  const validated = validateMutationPaths(input.sourcePath, input.targetPath, settings);
  const result = archiveDb
    .prepare(
      `INSERT INTO archive_operation
        (owner_id, kind, status, source_path, target_path, file_record_id, source_evidence_key,
         proposal_evidence, expected_size_bytes, expected_modified_at_ms, created_directories, rollback_available)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0)`,
    )
    .run(
      ownerId,
      input.kind,
      input.initialStatus ?? "queued",
      validated.sourcePath,
      validated.targetPath,
      input.fileRecordId,
      input.sourceEvidenceKey,
      JSON.stringify(input.proposalEvidence),
      input.expectedSizeBytes,
      input.expectedModifiedAtMs,
    );
  const id = Number(result.lastInsertRowid);
  addEvent("info", `Archive ${input.kind} operation queued: ${basename(validated.sourcePath)} -> ${basename(validated.targetPath)}`, "archive-operations", ownerId);
  return readOperation(ownerId, id);
}

export async function executeOperation(ownerId: string, operationId: number, settings: SettingsRecord = readSettings()) {
  const row = archiveDb
    .prepare("SELECT * FROM archive_operation WHERE owner_id = ? AND id = ?")
    .get(ownerId, operationId) as OperationRow | undefined;
  if (!row) throw new ArchiveMutationError("state", "Archive operation not found.");
  if (!["proposed", "approved", "queued"].includes(row.status)) {
    throw new ArchiveMutationError("state", `Operation cannot execute from status '${row.status}'.`);
  }

  setOperationState(operationId, ownerId, "running");
  let createdDirectories: string[] = [];
  try {
    // Re-validate against the settings in force at execution time; configuration
    // may have changed between proposal and apply.
    const validated = validateMutationPaths(row.source_path, row.target_path, settings);

    let stat;
    try {
      stat = await fs.lstat(validated.sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ArchiveMutationError("source_missing", `Source file does not exist: ${validated.sourcePath}`);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new ArchiveMutationError("symlink", "Source is a symlink; only regular files are relocated.");
    if (!stat.isFile()) throw new ArchiveMutationError("source_missing", "Source path is not a regular file.");
    if (row.expected_size_bytes != null && stat.size !== row.expected_size_bytes) {
      throw new ArchiveMutationError("source_changed", "Source size changed since the proposal; the operation was not executed.");
    }
    if (row.expected_modified_at_ms != null && Math.trunc(stat.mtimeMs) !== Math.trunc(row.expected_modified_at_ms)) {
      throw new ArchiveMutationError("source_changed", "Source modification time changed since the proposal; the operation was not executed.");
    }

    createdDirectories = await ensureTargetDirectory(validated.targetPath, validated.targetVolume.path);
    archiveDb
      .prepare("UPDATE archive_operation SET created_directories = ? WHERE id = ? AND owner_id = ?")
      .run(JSON.stringify(createdDirectories), operationId, ownerId);

    // The overwrite ban and the rename happen back-to-back: the journal
    // refuses to execute when the destination appeared at any point.
    try {
      await fs.lstat(validated.targetPath);
      throw new ArchiveMutationError("collision", `Target already exists; nothing was overwritten: ${validated.targetPath}`);
    } catch (error) {
      if (error instanceof ArchiveMutationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await fs.rename(validated.sourcePath, validated.targetPath);
    relocateArchiveRecord(ownerId, validated.sourcePath, validated.targetPath);
    invalidateArchiveInventoryCache(ownerId);

    setOperationState(operationId, ownerId, "succeeded", {
      error: null,
      applied_at: new Date().toISOString(),
      rollback_available: 1,
    });
    addEvent("success", `Archive ${row.kind} applied: ${basename(validated.targetPath)}`, "archive-operations", ownerId);
  } catch (error) {
    await removeEmptyDirectories(createdDirectories);
    const message = error instanceof Error ? error.message : "Archive operation failed.";
    setOperationState(operationId, ownerId, "failed", { error: message });
    addEvent("error", `Archive ${row.kind} failed: ${message}`, "archive-operations", ownerId);
    if (error instanceof ArchiveMutationError) throw error;
    throw error;
  }
  return readOperation(ownerId, operationId);
}

// Rollback replays the journal in reverse: it only succeeds when the renamed
// file is still exactly where the operation put it, and the original slot is
// free again. Anything else stays failed and untouched for operator review.
export async function rollbackOperation(ownerId: string, operationId: number, settings: SettingsRecord = readSettings()) {
  const row = archiveDb
    .prepare("SELECT * FROM archive_operation WHERE owner_id = ? AND id = ?")
    .get(ownerId, operationId) as OperationRow | undefined;
  if (!row) throw new ArchiveMutationError("state", "Archive operation not found.");
  if (row.status !== "succeeded" || row.rollback_available !== 1) {
    throw new ArchiveMutationError("state", `Operation '${row.status}' cannot be rolled back.`);
  }

  try {
    const validated = validateMutationPaths(row.target_path, row.source_path, settings);

    let currentStat;
    try {
      currentStat = await fs.lstat(validated.sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ArchiveMutationError("source_missing", `The renamed file no longer exists at its recorded destination: ${validated.sourcePath}`);
      }
      throw error;
    }
    if (!currentStat.isFile()) throw new ArchiveMutationError("source_missing", "Renamed file no longer exists at its recorded destination.");
    try {
      await fs.lstat(validated.targetPath);
      throw new ArchiveMutationError("collision", "The original path is occupied again; rollback refused to overwrite.");
    } catch (error) {
      if (error instanceof ArchiveMutationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await fs.rename(validated.sourcePath, validated.targetPath);
    relocateArchiveRecord(ownerId, validated.sourcePath, validated.targetPath);
    await removeEmptyDirectories(parseJsonArray(row.created_directories));
    invalidateArchiveInventoryCache(ownerId);

    setOperationState(operationId, ownerId, "rolled_back", {
      error: null,
      rolled_back_at: new Date().toISOString(),
      rollback_available: 0,
    });
    addEvent("info", `Archive ${row.kind} rolled back: ${basename(validated.targetPath)}`, "archive-operations", ownerId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rollback failed.";
    setOperationState(operationId, ownerId, row.status, { error: `Rollback failed: ${message}` });
    addEvent("error", `Rollback failed for operation ${operationId}: ${message}`, "archive-operations", ownerId);
    if (error instanceof ArchiveMutationError) throw error;
    throw error;
  }
  return readOperation(ownerId, operationId);
}

// ---------------------------------------------------------------------------
// Phase 5: controlled application of accepted naming proposals.
// ---------------------------------------------------------------------------

// One batch may touch a bounded number of files, keeping each mutation tied to
// a durable journal entry and a human decision made on matching evidence.
export const NAMING_APPLY_BATCH_LIMIT = 25;

type ProposalInput = {
  patternId: string;
  confidence: string;
  operation: string;
  reason: string;
  evidence: string[];
  sourceFilename: string;
  proposedFilename: string | null;
  sizeBytes: number | null;
  modifiedAtMs: number | null;
  archiveRoot: string;
  mediaType: string;
};

function proposalSnapshot(proposal: ProposalInput & { sourcePath: string; proposedPath: string | null }) {
  return {
    patternId: proposal.patternId,
    confidence: proposal.confidence,
    operation: proposal.operation,
    reason: proposal.reason,
    evidence: proposal.evidence,
    sourceFilename: proposal.sourceFilename,
    sourcePath: proposal.sourcePath,
    proposedFilename: proposal.proposedFilename,
    proposedPath: proposal.proposedPath,
    sizeBytes: proposal.sizeBytes,
    modifiedAtMs: proposal.modifiedAtMs,
    archiveRoot: proposal.archiveRoot,
    mediaType: proposal.mediaType,
  };
}

// Every apply attempt that passes the proposal gates is auditable, including
// ones that fail path re-validation before a journal row could be created.
function recordFailedAttempt(
  ownerId: string,
  input: {
    kind: ArchiveOperationKind;
    sourcePath: string;
    targetPath: string;
    fileRecordId: number;
    evidenceKey: string;
    proposalEvidence: Record<string, unknown>;
    error: string;
  },
) {
  const result = archiveDb.prepare(
    `INSERT INTO archive_operation
      (owner_id, kind, status, source_path, target_path, file_record_id, source_evidence_key,
       proposal_evidence, created_directories, error, rollback_available)
     VALUES (?, ?, 'failed', ?, ?, ?, ?, ?, '[]', ?, 0)`,
  ).run(
    ownerId,
    input.kind,
    input.sourcePath,
    input.targetPath,
    input.fileRecordId,
    input.evidenceKey,
    JSON.stringify(input.proposalEvidence),
    input.error,
  );
  addEvent("error", `Archive ${input.kind} rejected before execution: ${input.error}`, "archive-operations", ownerId);
  return readOperation(ownerId, Number(result.lastInsertRowid));
}

export async function applyNamingProposals(
  ownerId: string,
  fileRecordIds: number[],
  options: { dryRun?: boolean } = {},
  settings: SettingsRecord = readSettings(),
) {
  const uniqueIds = [...new Set(fileRecordIds)];
  if (!uniqueIds.length) throw new Error("At least one proposal record id is required.");
  if (uniqueIds.length > NAMING_APPLY_BATCH_LIMIT) {
    throw new Error(`A single apply batch is limited to ${NAMING_APPLY_BATCH_LIMIT} proposals.`);
  }
  const dryRun = options.dryRun === true;
  const proposals = new Map((await buildNamingProposals(ownerId, settings)).map((proposal) => [proposal.fileRecordId, proposal]));

  const results = await Promise.all(uniqueIds.map(async (fileRecordId) => {
    const proposal = proposals.get(fileRecordId);
    const fail = (error: string, operation = null as ReturnType<typeof readOperation>) => ({
      fileRecordId,
      success: false as const,
      error,
      operation,
      plan: null as OperationPlan | null,
    });

    if (!proposal) {
      return fail("No current naming proposal exists for this archive record.");
    }
    if (!proposal.proposedPath || proposal.collision || proposal.operation === "uncertain/no_action") {
      return fail(`This proposal has no executable destination (${proposal.patternId}); nothing was applied.`);
    }
    if (proposal.decisionStatus !== "accepted") {
      return fail(
        proposal.decisionStale
          ? "The stored decision is based on superseded evidence; the proposal was reopened for review."
          : `The proposal must be accepted before it can be applied (current decision: ${proposal.decisionStatus}).`,
      );
    }

    const kind: ArchiveOperationKind = proposal.operation === "rename" ? "rename" : "restructure";
    const targetPath = proposal.proposedPath;
    const snapshot = proposalSnapshot({ ...proposal, proposedPath: targetPath });
    const expected = { sizeBytes: proposal.sizeBytes, modifiedAtMs: proposal.modifiedAtMs };

    if (dryRun) {
      // Same gates and checks as execution, with zero filesystem or database
      // writes, so operators can preview collisions and stale evidence first.
      const plan = await dryRunMutation(proposal.sourcePath, targetPath, ownerId, settings, expected);
      return {
        fileRecordId,
        success: plan.ok,
        error: plan.error,
        operation: null as ReturnType<typeof readOperation>,
        plan: { ...plan, kind },
      };
    }

    let created: Awaited<ReturnType<typeof readOperation>> = null;
    try {
      created = createOperation(ownerId, {
        kind,
        sourcePath: proposal.sourcePath,
        targetPath: proposal.proposedPath,
        fileRecordId: proposal.fileRecordId,
        sourceEvidenceKey: proposal.evidenceKey,
        proposalEvidence: snapshot,
        expectedSizeBytes: proposal.sizeBytes,
        expectedModifiedAtMs: proposal.modifiedAtMs,
        initialStatus: "approved",
      }, settings);
      if (!created) throw new Error("The archive operation journal entry could not be created.");
      const executed = await executeOperation(ownerId, created.id, settings);
      const succeeded = executed?.status === "succeeded";
      return {
        fileRecordId,
        success: succeeded,
        error: succeeded ? null : executed?.error ?? "The operation did not reach a succeeded state.",
        operation: executed,
        plan: null as OperationPlan | null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Archive operation failed.";
      const attempted = created ?? recordFailedAttempt(ownerId, {
        kind,
        sourcePath: proposal.sourcePath,
        targetPath: proposal.proposedPath,
        fileRecordId: proposal.fileRecordId,
        evidenceKey: proposal.evidenceKey,
        proposalEvidence: snapshot,
        error: message,
      });
      // Re-read the journal row so the per-item result reports the final
      // state (failed + error) rather than the status captured at creation.
      const operation = attempted ? readOperation(ownerId, attempted.id) ?? attempted : null;
      return { fileRecordId, success: false as const, error: message, operation, plan: null as OperationPlan | null };
    }
  }));

  const succeeded = results.filter((result) => result.success).length;
  return {
    requested: results.length,
    dryRun,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}
