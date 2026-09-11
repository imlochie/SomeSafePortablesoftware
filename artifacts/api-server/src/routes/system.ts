import { statfsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Router, type IRouter } from "express";
import {
  GetSystemDependenciesResponse,
  GetSystemEventsResponse,
  GetSystemOverviewResponse,
} from "@workspace/api-zod";
import { archiveDb, pruneSystemEvents, readEvents, readSettings } from "../lib/archive-db";
import { runtimeConfig } from "../lib/runtime-config";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { getArchiveVolumes } from "../services/storage";
import {
  dependencyDefinitions,
  detectDependency,
} from "../services/system-dependencies";

const router: IRouter = Router();

function expandHome(value: string) {
  return value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value);
}

function readStorage(settings: ReturnType<typeof readSettings>) {
  const volumes = getArchiveVolumes(settings);

  const readableVolumes = volumes.filter((volume) => volume.exists);

  if (!readableVolumes.length) {
    return {
      path: settings.archiveDirectory,
      freeBytes: 0,
      totalBytes: 0,
      usedBytes: 0,
      freePercent: 0,
      status: "unavailable" as const,
    };
  }

  let totalBytes = 0;
  let freeBytes = 0;

  for (const volume of readableVolumes) {
    try {
      const stats = statfsSync(volume.path);
      totalBytes += Number(stats.blocks) * Number(stats.bsize);
      freeBytes += Number(stats.bavail) * Number(stats.bsize);
    } catch {
      // Ignore an individual volume that cannot be queried.
    }
  }

  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const freePercent = totalBytes
    ? (freeBytes / totalBytes) * 100
    : 0;

  return {
    path: volumes.map((volume) => volume.path).join("\n"),
    freeBytes,
    totalBytes,
    usedBytes,
    freePercent,
    status:
      freePercent <= settings.criticalFreePercent
        ? ("critical" as const)
        : freePercent <= settings.warningFreePercent
          ? ("warning" as const)
          : ("ready" as const),
  };
}

router.get("/system/overview", (req, res) => {
  const ownerId = getAuthenticatedUserId(req);
  pruneSystemEvents(ownerId);
  const settings = readSettings();
  const events = readEvents(ownerId, 8);
  const activeDownloads = archiveDb.prepare("SELECT COUNT(*) AS count FROM download_job WHERE owner_id = ? AND status IN ('inspecting', 'downloading')").get(ownerId) as { count: number };
  const queuedJobs = archiveDb.prepare("SELECT COUNT(*) AS count FROM download_job WHERE owner_id = ? AND status IN ('queued', 'recovery_required', 'paused')").get(ownerId) as { count: number };
  const processingJobs = archiveDb.prepare("SELECT COUNT(*) AS count FROM download_job WHERE owner_id = ? AND status IN ('downloaded', 'processing', 'verifying', 'moving')").get(ownerId) as { count: number };
  const completedToday = archiveDb.prepare("SELECT COUNT(*) AS count FROM download_job WHERE owner_id = ? AND status = 'complete' AND date(completed_at) = date('now')").get(ownerId) as { count: number };
  const failedToday = archiveDb.prepare("SELECT COUNT(*) AS count FROM download_job WHERE owner_id = ? AND status = 'failed' AND date(updated_at) = date('now')").get(ownerId) as { count: number };
  const storage = readStorage(settings);
  const payload = GetSystemOverviewResponse.parse({
    archiveStatus: "ready",
    plexStatus: "placeholder",
    queueStatus: activeDownloads.count || queuedJobs.count ? "processing" : "idle",
    processingStatus: processingJobs.count ? "processing" : "idle",
    storageStatus: storage.status === "unavailable" ? "unavailable" : storage.status === "warning" || storage.status === "critical" ? "warning" : "ready",
    aiStatus: settings.mockMode ? "placeholder" : "unavailable",
    lastSync: null,
    activity: events,
    activeDownloads: activeDownloads.count,
    queuedJobs: queuedJobs.count,
    processingJobs: processingJobs.count,
    completedToday: completedToday.count,
    failedToday: failedToday.count,
    storage,
  });
  res.json(payload);
});

router.get("/system/dependencies", (_req, res) => {
  const settings = readSettings();
  res.json(
    GetSystemDependenciesResponse.parse({
      dependencies: dependencyDefinitions.map((dependency) =>
        detectDependency(dependency, settings),
      ),
      mediaBundle: runtimeConfig.mediaBundle,
    }),
  );
});

router.get("/system/events", (req, res) => {
  const ownerId = getAuthenticatedUserId(req);
  pruneSystemEvents(ownerId);
  res.json(GetSystemEventsResponse.parse(readEvents(ownerId)));
});

export default router;