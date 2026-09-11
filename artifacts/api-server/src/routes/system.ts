import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Router, type IRouter } from "express";
import {
  GetSystemDependenciesResponse,
  GetSystemEventsResponse,
  GetSystemOverviewResponse,
} from "@workspace/api-zod";
import { archiveDb, readEvents, readSettings } from "../lib/archive-db";
import { getLocalToolPaths } from "../services/local-tools";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { getArchiveVolumes } from "../services/storage";

const router: IRouter = Router();

const execFileAsync = promisify(execFile);

/**
 * Version probes are asynchronous: the synchronous variants (execFileSync and
 * spawnSync with piped stdio) deadlock outright for some Windows executables —
 * a configured yt-dlp.exe answers "--version" with ETIMEDOUT under every
 * synchronous pipe configuration, while the same probe through execFile/spawn
 * resolves immediately. The asynchronous path also keeps the event loop free
 * while a cold executable starts, so the timeout can be generous enough for
 * real-world Python-packaged tools without ever blocking a request.
 */
const DEPENDENCY_PROBE_TIMEOUT_MS = 5_000;

const dependencyDefinitions = [
  { name: "Node.js", key: null, fallback: "node", args: ["--version"] },
  { name: "SQLite", key: null, fallback: "sqlite3", args: ["--version"] },
  { name: "FFmpeg", key: "ffmpeg", fallback: "ffmpeg", args: ["-version"] },
  { name: "ffprobe", key: "ffprobe", fallback: "ffprobe", args: ["-version"] },
  { name: "yt-dlp", key: "ytDlp", fallback: "yt-dlp", args: ["--version"] },
] as const;

async function detectDependency(dependency: (typeof dependencyDefinitions)[number], settings: ReturnType<typeof readSettings>) {
  const tools = getLocalToolPaths(settings);
  const command = dependency.key ? tools[dependency.key] : dependency.fallback;
  try {
    const { stdout } = await execFileAsync(command, dependency.args, {
      encoding: "utf8",
      timeout: DEPENDENCY_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const version = stdout.trim().split(/\r?\n/)[0] ?? null;
    const capabilities = dependency.name === "FFmpeg" ? await detectFfmpegCapabilities(tools.ffmpeg) : [];
    return {
      name: dependency.name,
      command,
      status: "available" as const,
      detail: "Detected on this machine",
      version,
      capabilities,
    };
  } catch {
    return {
        name: dependency.name,
        command,
        status: dependency.name === "SQLite" ? ("not_configured" as const) : ("missing" as const),
      detail:
          dependency.name === "SQLite"
          ? "Using the embedded SQLite runtime"
          : "Optional dependency not detected",
      version: null,
capabilities: [],
    };
  }
}

async function detectFfmpegCapabilities(command: string) {
  try {
    const { stdout } = await execFileAsync(command, ["-hide_banner", "-hwaccels"], {
      encoding: "utf8",
      timeout: DEPENDENCY_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.includes("Hardware acceleration"));
  } catch {
    return [];
  }
}

/**
 * Every dependency probe, run concurrently. Exported for the regression test:
 * a configured absolute executable path (the Windows layout, e.g.
 * C:\Users\...\yt-dlp.exe) must be detected through the asynchronous path.
 */
export async function readSystemDependencies(settings: ReturnType<typeof readSettings> = readSettings()) {
  return Promise.all(dependencyDefinitions.map((dependency) => detectDependency(dependency, settings)));
}

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

router.get("/system/dependencies", (_req, res, next) => {
  void (async () => {
    try {
      const settings = readSettings();
      const dependencies = await readSystemDependencies(settings);
      res.json(GetSystemDependenciesResponse.parse(dependencies));
    } catch (error) {
      next(error);
    }
  })();
});

router.get("/system/events", (req, res) => {
  res.json(GetSystemEventsResponse.parse(readEvents(getAuthenticatedUserId(req))));
});

export default router;