import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { archiveDb, readSettings } from "../../lib/archive-db";
import { isPathWithin } from "../media";
import { findArchiveVolumeForPath, getArchiveScanRoots } from "../storage";
import {
  actionTypes,
  type ActionHandler,
  type ActionHandlerContext,
  type ActionStep,
  type ActionType,
} from "./types";

function stepPaths(step: ActionStep) {
  const from = step.before.path;
  const to = step.after.path;
  if (typeof from !== "string" || !from.trim()) {
    throw new Error("Action step is missing a source path.");
  }
  if (typeof to !== "string" || !to.trim()) {
    throw new Error("Action step is missing a destination path.");
  }
  return { sourcePath: resolve(from), destinationPath: resolve(to) };
}

/**
 * Filesystem actions may only touch configured Archive Assistant directories.
 * This is the same containment rule the original archive-operations service
 * enforced, kept central so every action family inherits it.
 */
function assertPathAllowed(path: string, label: string) {
  const settings = readSettings();
  const roots = [
    settings.dataDirectory,
    settings.downloadDirectory,
    settings.temporaryDirectory,
    ...getArchiveScanRoots(settings),
  ];
  if (!roots.some((root) => root?.trim() && isPathWithin(path, root))) {
    throw new Error(`${label} is outside configured Archive Assistant directories.`);
  }
}

async function preflightFilesystemMutation(
  step: ActionStep,
  context: ActionHandlerContext,
  options: { requireArchiveVolume: boolean },
) {
  const { sourcePath, destinationPath } = stepPaths(step);
  const { dependencies, proposal } = context;
  if (sourcePath === destinationPath) {
    throw new Error("Source and destination paths must differ.");
  }
  assertPathAllowed(sourcePath, "Source path");

  const settings = readSettings();
  let destinationVolume = null as ReturnType<typeof findArchiveVolumeForPath>;
  if (options.requireArchiveVolume) {
    destinationVolume = findArchiveVolumeForPath(destinationPath, settings);
    if (!destinationVolume) throw new Error("Destination path is outside configured archive volumes.");
    if (!destinationVolume.exists || !destinationVolume.writable) {
      throw new Error("Destination archive volume is unavailable or not writable.");
    }
  } else {
    assertPathAllowed(destinationPath, "Destination path");
  }

  const source = await dependencies.stat(sourcePath);
  if (!source.isFile()) throw new Error("Action source is not a regular file.");

  const destinationDirectory = dirname(destinationPath);
  let directoryMissing = false;
  try {
    await dependencies.access(destinationDirectory, fsConstants.W_OK);
  } catch {
    directoryMissing = true;
  }
  if (directoryMissing && !proposal.allowCreateDirectories) {
    throw new Error("Destination directory does not exist or is not writable.");
  }
  if (directoryMissing) assertPathAllowed(destinationDirectory, "Destination directory");

  let destinationExists = false;
  try {
    await dependencies.stat(destinationPath);
    destinationExists = true;
  } catch {
    destinationExists = false;
  }
  if (destinationExists) throw new Error("Destination collision detected; overwrite is not allowed.");

  if (
    destinationVolume?.freeBytes != null
    && destinationVolume.freeBytes < source.size
  ) {
    throw new Error("Destination volume does not have enough free space.");
  }

  return {
    sourceExists: true,
    sourceSizeBytes: source.size,
    destinationExists: false,
    destinationDirectoryMissing: directoryMissing,
    destinationVolume: destinationVolume
      ? { id: destinationVolume.id, path: destinationVolume.path, freeBytes: destinationVolume.freeBytes }
      : null,
    checkedAt: new Date().toISOString(),
  };
}

async function verifyMovedFile(step: ActionStep, context: ActionHandlerContext) {
  const { sourcePath, destinationPath } = stepPaths(step);
  const expectedSize = Number(step.preflight.sourceSizeBytes);
  const destination = await context.dependencies.stat(destinationPath);
  if (!destination.isFile()) throw new Error("Destination is not a regular file after execution.");
  if (Number.isFinite(expectedSize) && destination.size !== expectedSize) {
    throw new Error("Destination size does not match the verified source size.");
  }
  let sourceRemoved = false;
  try {
    await context.dependencies.stat(sourcePath);
  } catch {
    sourceRemoved = true;
  }
  return {
    verified: true,
    destinationSizeBytes: destination.size,
    expectedSizeBytes: Number.isFinite(expectedSize) ? expectedSize : null,
    sourceRemoved,
    verifiedAt: new Date().toISOString(),
  };
}

async function ensureDestinationDirectory(step: ActionStep, context: ActionHandlerContext) {
  if (!step.preflight.destinationDirectoryMissing) return false;
  const { destinationPath } = stepPaths(step);
  await context.dependencies.mkdir(dirname(destinationPath));
  return true;
}

/**
 * rename / move are the same primitive with different intent: rename stays in
 * place, move relocates. Both are reversible by putting the file back.
 */
function relocationHandler(type: Extract<ActionType, "rename" | "move">): ActionHandler {
  return {
    type,
    supported: true,
    mutatesFiles: true,
    reversible: true,
    risk: type === "rename" ? "low" : "medium",
    description: type === "rename"
      ? "Rename a file in place to the archive naming convention."
      : "Relocate a file to a different archive path.",
    summarize(step) {
      const from = String(step.before.filename ?? step.before.path ?? "");
      const to = String(step.after.filename ?? step.after.path ?? "");
      return `${from} → ${to}`;
    },
    async preflight(step, context) {
      return preflightFilesystemMutation(step, context, { requireArchiveVolume: type === "move" });
    },
    async execute(step, context) {
      const { sourcePath, destinationPath } = stepPaths(step);
      const createdDirectory = await ensureDestinationDirectory(step, context);
      await context.dependencies.rename(sourcePath, destinationPath);
      return {
        performed: type,
        sourcePath,
        destinationPath,
        createdDirectory,
        executedAt: new Date().toISOString(),
      };
    },
    verify: verifyMovedFile,
    async revert(step, context) {
      const { sourcePath, destinationPath } = stepPaths(step);
      let collision = false;
      try {
        await context.dependencies.stat(sourcePath);
        collision = true;
      } catch {
        collision = false;
      }
      if (collision) throw new Error("Revert collision detected at the original source path.");
      await context.dependencies.rename(destinationPath, sourcePath);
      if (step.execution.createdDirectory) {
        try {
          await context.dependencies.rmdir(dirname(destinationPath));
        } catch {
          // A non-empty directory is left in place; the revert itself succeeded.
        }
      }
      return { restoredPath: sourcePath, revertedAt: new Date().toISOString() };
    },
  };
}

/** import copies a verified external file into the archive; revert removes the copy. */
const importHandler: ActionHandler = {
  type: "import",
  supported: true,
  mutatesFiles: true,
  reversible: true,
  risk: "medium",
  description: "Copy a verified acquired file into the archive without removing the source.",
  summarize(step) {
    return `Import ${String(step.before.path ?? "")} → ${String(step.after.path ?? "")}`;
  },
  async preflight(step, context) {
    return preflightFilesystemMutation(step, context, { requireArchiveVolume: true });
  },
  async execute(step, context) {
    const { sourcePath, destinationPath } = stepPaths(step);
    const createdDirectory = await ensureDestinationDirectory(step, context);
    await context.dependencies.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    return {
      performed: "import",
      sourcePath,
      destinationPath,
      createdDirectory,
      executedAt: new Date().toISOString(),
    };
  },
  async verify(step, context) {
    const { destinationPath } = stepPaths(step);
    const expectedSize = Number(step.preflight.sourceSizeBytes);
    const destination = await context.dependencies.stat(destinationPath);
    if (!destination.isFile()) throw new Error("Imported destination is not a regular file.");
    if (Number.isFinite(expectedSize) && destination.size !== expectedSize) {
      throw new Error("Imported file size does not match the verified source size.");
    }
    const inspection = await context.dependencies.inspect(destinationPath);
    return {
      verified: true,
      destinationSizeBytes: destination.size,
      expectedSizeBytes: Number.isFinite(expectedSize) ? expectedSize : null,
      inspection,
      verifiedAt: new Date().toISOString(),
    };
  },
  async revert(step, context) {
    const { destinationPath } = stepPaths(step);
    await context.dependencies.unlink(destinationPath);
    if (step.execution.createdDirectory) {
      try {
        await context.dependencies.rmdir(dirname(destinationPath));
      } catch {
        // Leaving a populated directory behind is acceptable.
      }
    }
    return { removedPath: destinationPath, revertedAt: new Date().toISOString() };
  },
};

/* ------------------------------------------------------------- reconcile -- */

/**
 * `reconcile` is the first action family that does not touch the filesystem.
 *
 * It records a confirmed identity link between a local file and a Plex item.
 * Because nothing is written to disk, none of the path-based helpers above
 * apply: there is no source to stat, no destination collision, and no rename
 * to undo. What it shares with rename is the *lifecycle* — propose, select,
 * approve, preflight, execute, verify, revert — which is the part that was
 * supposed to be universal.
 */
function reconcileTargets(step: ActionStep) {
  const fileRecordId = Number(step.before.fileRecordId ?? step.target.id);
  const ratingKey = String(step.after.ratingKey ?? "").trim();
  if (!Number.isInteger(fileRecordId) || fileRecordId <= 0) {
    throw new Error("Reconcile step is missing a local file record id.");
  }
  if (!ratingKey) throw new Error("Reconcile step is missing a Plex rating key.");
  return { fileRecordId, ratingKey };
}

function readLinkRow(ownerId: string, fileRecordId: number) {
  return archiveDb.prepare(
    `SELECT id, plex_rating_key, identity_key FROM media_identity_link
     WHERE owner_id = ? AND file_record_id = ?`,
  ).get(ownerId, fileRecordId) as
    { id: number; plex_rating_key: string; identity_key: string } | undefined;
}

const reconcileHandler: ActionHandler = {
  type: "reconcile",
  supported: true,
  // The archive's bytes are untouched; only the identity record changes.
  mutatesFiles: false,
  reversible: true,
  risk: "low",
  description: "Record a confirmed identity link between a local file and a Plex item.",
  summarize(step) {
    const from = String(step.before.label ?? step.before.filename ?? step.target.label ?? "local file");
    const to = String(step.after.label ?? step.after.title ?? step.after.ratingKey ?? "Plex item");
    return `${from} ⇄ ${to}`;
  },

  /**
   * Preflight for a record action re-reads the rows the plan was built from.
   * The analogue of "does the source file still exist?" is "do both records
   * still exist, and is neither already spoken for?".
   */
  async preflight(step, context) {
    const { fileRecordId, ratingKey } = reconcileTargets(step);
    const { ownerId } = context;

    const file = archiveDb.prepare(
      `SELECT id, path, filename, scan_status FROM file_record WHERE id = ? AND owner_id = ?`,
    ).get(fileRecordId, ownerId) as
      { id: number; path: string; filename: string; scan_status: string } | undefined;
    if (!file) throw new Error("The local file record no longer exists.");
    if (file.scan_status !== "active") {
      throw new Error(`The local file is no longer active in the archive (${file.scan_status}).`);
    }

    const plexItem = archiveDb.prepare(
      `SELECT id, rating_key, title FROM plex_item WHERE rating_key = ? AND owner_id = ?`,
    ).get(ratingKey, ownerId) as { id: number; rating_key: string; title: string } | undefined;
    if (!plexItem) throw new Error("The Plex item is no longer present in the local snapshot.");

    // Neither side may already be claimed by a different confirmed link.
    const existingForFile = readLinkRow(ownerId, fileRecordId);
    if (existingForFile && existingForFile.plex_rating_key !== ratingKey) {
      throw new Error("This file is already linked to a different Plex item.");
    }
    const existingForPlex = archiveDb.prepare(
      `SELECT file_record_id FROM media_identity_link
       WHERE owner_id = ? AND plex_rating_key = ? AND file_record_id <> ?`,
    ).get(ownerId, ratingKey, fileRecordId) as { file_record_id: number } | undefined;
    if (existingForPlex) {
      throw new Error("That Plex item is already linked to a different local file.");
    }

    return {
      // Deliberately mirrors the filesystem vocabulary where it is honest, so
      // the review surface can report "still there" for both kinds of action.
      sourceExists: true,
      destinationExists: Boolean(existingForFile),
      localPath: file.path,
      localFilename: file.filename,
      plexTitle: plexItem.title,
      ratingKey,
      alreadyLinked: Boolean(existingForFile),
      checkedAt: new Date().toISOString(),
    };
  },

  async execute(step, context) {
    const { fileRecordId, ratingKey } = reconcileTargets(step);
    const { ownerId } = context;
    const identityKey = String(step.after.identityKey ?? step.before.identityKey ?? "");
    const strategy = String(step.before.matchingStrategy ?? "operator_confirmed");
    const previous = readLinkRow(ownerId, fileRecordId);

    archiveDb.prepare(
      `INSERT INTO media_identity_link
         (owner_id, file_record_id, plex_rating_key, identity_key, matching_strategy,
          confidence, evidence_json, linked_by, action_step_id)
       VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
       ON CONFLICT (owner_id, file_record_id) DO UPDATE SET
         plex_rating_key = excluded.plex_rating_key,
         identity_key = excluded.identity_key,
         matching_strategy = excluded.matching_strategy,
         confidence = excluded.confidence,
         evidence_json = excluded.evidence_json,
         action_step_id = excluded.action_step_id,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(
      ownerId,
      fileRecordId,
      ratingKey,
      identityKey,
      strategy,
      JSON.stringify(step.before.evidence ?? {}),
      ownerId,
      step.id,
    );

    return {
      performed: "reconcile",
      fileRecordId,
      ratingKey,
      identityKey,
      // Recorded so revert can restore the prior state rather than assuming none.
      previousRatingKey: previous?.plex_rating_key ?? null,
      executedAt: new Date().toISOString(),
    };
  },

  /** Verification reads the record back rather than stat-ing a path. */
  async verify(step, context) {
    const { fileRecordId, ratingKey } = reconcileTargets(step);
    const link = readLinkRow(context.ownerId, fileRecordId);
    if (!link) throw new Error("The identity link was not found after execution.");
    if (link.plex_rating_key !== ratingKey) {
      throw new Error("The stored identity link does not match the approved Plex item.");
    }
    return {
      verified: true,
      linkId: link.id,
      fileRecordId,
      ratingKey,
      verifiedAt: new Date().toISOString(),
    };
  },

  async revert(step, context) {
    const { fileRecordId } = reconcileTargets(step);
    const { ownerId } = context;
    const previousRatingKey = step.execution.previousRatingKey;
    if (typeof previousRatingKey === "string" && previousRatingKey.trim()) {
      // Restore the link that existed before, rather than leaving nothing.
      archiveDb.prepare(
        `UPDATE media_identity_link
         SET plex_rating_key = ?, updated_at = CURRENT_TIMESTAMP
         WHERE owner_id = ? AND file_record_id = ?`,
      ).run(previousRatingKey, ownerId, fileRecordId);
      return { restoredRatingKey: previousRatingKey, revertedAt: new Date().toISOString() };
    }
    archiveDb.prepare(
      `DELETE FROM media_identity_link WHERE owner_id = ? AND file_record_id = ?`,
    ).run(ownerId, fileRecordId);
    return { removedLinkFor: fileRecordId, revertedAt: new Date().toISOString() };
  },
};

/**
 * Declared-but-unimplemented families. They exist so the vocabulary is complete
 * and the UI can honestly report "not yet available" instead of each feature
 * inventing its own execution path later.
 */
function plannedHandler(
  type: ActionType,
  description: string,
  options: { mutatesFiles: boolean; reversible: boolean; risk: ActionHandler["risk"] },
): ActionHandler {
  const unavailable = () => {
    throw new Error(`The "${type}" action family is declared but not implemented yet.`);
  };
  return {
    type,
    supported: false,
    mutatesFiles: options.mutatesFiles,
    reversible: options.reversible,
    risk: options.risk,
    description,
    summarize: (step) => step.summary || type,
    preflight: async () => unavailable(),
    execute: async () => unavailable(),
    verify: async () => unavailable(),
    revert: async () => unavailable(),
  };
}

const handlers = new Map<ActionType, ActionHandler>([
  ["rename", relocationHandler("rename")],
  ["move", relocationHandler("move")],
  ["import", importHandler],
  ["delete", plannedHandler("delete", "Remove a file from the archive after retention review.", {
    mutatesFiles: true, reversible: false, risk: "high",
  })],
  ["restore", plannedHandler("restore", "Restore a quarantined or previously removed file.", {
    mutatesFiles: true, reversible: true, risk: "medium",
  })],
  ["reconcile", reconcileHandler],
  ["acquire", plannedHandler("acquire", "Request missing media through an acquisition provider.", {
    mutatesFiles: false, reversible: true, risk: "medium",
  })],
  ["link", plannedHandler("link", "Associate an archive record with an external identity.", {
    mutatesFiles: false, reversible: true, risk: "low",
  })],
  ["unlink", plannedHandler("unlink", "Remove an association between records.", {
    mutatesFiles: false, reversible: true, risk: "low",
  })],
  ["metadata_update", plannedHandler("metadata_update", "Apply corrected metadata to archive records.", {
    mutatesFiles: false, reversible: true, risk: "low",
  })],
  ["plex_sync", plannedHandler("plex_sync", "Register or refresh an item in Plex.", {
    mutatesFiles: false, reversible: false, risk: "low",
  })],
]);

export function getActionHandler(type: ActionType): ActionHandler {
  const handler = handlers.get(type);
  if (!handler) throw new Error(`Action type "${type}" has no registered handler.`);
  return handler;
}

export function requireSupportedHandler(type: ActionType): ActionHandler {
  const handler = getActionHandler(type);
  if (!handler.supported) {
    throw new Error(`The "${type}" action family is declared but not implemented yet.`);
  }
  return handler;
}

export function listActionCapabilities() {
  return actionTypes.map((type) => {
    const handler = getActionHandler(type);
    return {
      type: handler.type,
      supported: handler.supported,
      mutatesFiles: handler.mutatesFiles,
      reversible: handler.reversible,
      risk: handler.risk,
      description: handler.description,
    };
  });
}
