/**
 * Post-execution reconciliation: after the archive changes, re-observe it.
 *
 * This closes the loop in the OBSERVE → ... → ACTION → RESULT → OBSERVE cycle
 * and is shared by every action family rather than reimplemented per feature.
 */
import { readArchiveScan, startArchiveScan } from "../archive";
import { getPlexConfig, syncPlexInventory } from "../plex";
import { readReconciliationReport } from "../reconciliation";

async function waitForArchiveScan(ownerId: string) {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const scan = readArchiveScan(ownerId);
    if (scan.status !== "scanning") return scan;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Post-operation archive scan did not finish within 60 seconds.");
}

export interface PostflightOutcome extends Record<string, unknown> {
  startedAt: string;
  archiveScan: unknown;
  plex: Record<string, unknown>;
  reconciliation: unknown;
  errors: string[];
  completedAt?: string;
  status?: string;
}

export async function runArchivePostflight(ownerId: string): Promise<PostflightOutcome> {
  const outcome: PostflightOutcome = {
    startedAt: new Date().toISOString(),
    archiveScan: null,
    plex: { configured: false, attempted: false },
    reconciliation: null,
    errors: [],
  };
  const errors = outcome.errors;

  try {
    startArchiveScan(ownerId);
    outcome.archiveScan = await waitForArchiveScan(ownerId);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Archive scan failed.");
  }

  try {
    const plex = getPlexConfig(ownerId);
    outcome.plex = {
      configured: plex.configured,
      attempted: plex.configured,
      status: plex.syncStatus,
      error: plex.lastError,
    };
    if (plex.configured) {
      await syncPlexInventory(ownerId);
      const refreshed = getPlexConfig(ownerId);
      outcome.plex = {
        configured: true,
        attempted: true,
        status: refreshed.syncStatus,
        error: refreshed.lastError,
        lastSuccessfulSyncAt: refreshed.lastSuccessfulSyncAt,
      };
      if (refreshed.syncStatus === "sync_error") {
        errors.push(refreshed.lastError ?? "Plex synchronization failed.");
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Plex refresh failed.");
  }

  try {
    outcome.reconciliation = await readReconciliationReport(ownerId, 1, 25);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Reconciliation failed.");
  }

  outcome.completedAt = new Date().toISOString();
  outcome.status = errors.length ? "completed_with_errors" : "completed";
  return outcome;
}
