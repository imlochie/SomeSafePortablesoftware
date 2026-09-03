import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Router, type IRouter } from "express";
import {
  GetSystemDependenciesResponse,
  GetSystemEventsResponse,
  GetSystemOverviewResponse,
} from "@workspace/api-zod";
import { archiveDb, readEvents, readSettings } from "../lib/archive-db";
import { getLocalToolPaths } from "../services/local-tools";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";

const router: IRouter = Router();

const dependencyDefinitions = [
  { name: "Node.js", key: null, fallback: "node", args: ["--version"] },
  { name: "SQLite", key: null, fallback: "sqlite3", args: ["--version"] },
  { name: "FFmpeg", key: "ffmpeg", fallback: "ffmpeg", args: ["-version"] },
  { name: "ffprobe", key: "ffprobe", fallback: "ffprobe", args: ["-version"] },
  { name: "yt-dlp", key: "ytDlp", fallback: "yt-dlp", args: ["--version"] },
] as const;

function detectDependency(dependency: (typeof dependencyDefinitions)[number], settings: ReturnType<typeof readSettings>) {
  const tools = getLocalToolPaths(settings);
  const command = dependency.key ? tools[dependency.key] : dependency.fallback;
  try {
    const versionOutput = execFileSync(command, dependency.args, {
      encoding: "utf8",
      timeout: 1200,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const version = versionOutput.trim().split(/\r?\n/)[0] ?? null;
    const capabilities = dependency.name === "FFmpeg" ? detectFfmpegCapabilities(tools.ffmpeg) : [];
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
    };
  }
}

function detectFfmpegCapabilities(command: string) {
  try {
    const output = execFileSync(command, ["-hide_banner", "-hwaccels"], {
      encoding: "utf8",
      timeout: 1800,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.includes("Hardware acceleration"));
  } catch {
    return [];
  }
}

function expandHome(value: string) {
  return value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value);
}

function readStorage(settings: ReturnType<typeof readSettings>) {
  const path = expandHome(settings.archiveDirectory);
  try {
    const stats = statfsSync(path);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const freePercent = totalBytes ? (freeBytes / totalBytes) * 100 : 0;
    return {
      path,
      freeBytes,
      totalBytes,
      usedBytes,
      freePercent,
      status: freePercent <= settings.criticalFreePercent ? "critical" as const : freePercent <= settings.warningFreePercent ? "warning" as const : "ready" as const,
    };
  } catch {
    return { path, freeBytes: 0, totalBytes: 0, usedBytes: 0, freePercent: 0, status: "unavailable" as const };
  }
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

router.get("/system/dependencies", (_req, res) => {
  const settings = readSettings();
  res.json(GetSystemDependenciesResponse.parse(dependencyDefinitions.map((dependency) => detectDependency(dependency, settings))));
});

router.get("/system/events", (req, res) => {
  res.json(GetSystemEventsResponse.parse(readEvents(getAuthenticatedUserId(req))));
});

export default router;