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

const router: IRouter = Router();

const dependencies = [
  { name: "Node.js", command: "node", args: ["--version"] },
  { name: "SQLite", command: "sqlite3", args: ["--version"] },
  { name: "FFmpeg", command: "ffmpeg", args: ["-version"] },
  { name: "ffprobe", command: "ffprobe", args: ["-version"] },
  { name: "yt-dlp", command: "yt-dlp", args: ["--version"] },
] as const;

function detectDependency(dependency: (typeof dependencies)[number]) {
  try {
    const versionOutput = execFileSync(dependency.command, dependency.args, {
      encoding: "utf8",
      timeout: 1200,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const version = versionOutput.trim().split(/\r?\n/)[0] ?? null;
    const capabilities = dependency.command === "ffmpeg" ? detectFfmpegCapabilities() : [];
    return {
      name: dependency.name,
      command: dependency.command,
      status: "available" as const,
      detail: "Detected on this machine",
      version,
      capabilities,
    };
  } catch {
    return {
      name: dependency.name,
      command: dependency.command,
      status: dependency.command === "sqlite3" ? ("not_configured" as const) : ("missing" as const),
      detail:
        dependency.command === "sqlite3"
          ? "Using the embedded SQLite runtime"
          : "Optional dependency not detected",
      version: null,
    };
  }
}

function detectFfmpegCapabilities() {
  try {
    const output = execFileSync("ffmpeg", ["-hide_banner", "-hwaccels"], {
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

router.get("/system/overview", (_req, res) => {
  const settings = readSettings();
  const events = readEvents(8);
  const activeDownloads = archiveDb.prepare("SELECT COUNT(*) AS count FROM download_job WHERE status IN ('inspecting', 'downloading')").get() as { count: number };
  const queuedJobs = archiveDb.prepare("SELECT COUNT(*) AS count FROM download_job WHERE status IN ('queued', 'recovery_required', 'paused')").get() as { count: number };
  const processingJobs = archiveDb.prepare("SELECT COUNT(*) AS count FROM download_job WHERE status IN ('downloaded', 'processing', 'verifying', 'moving')").get() as { count: number };
  const completedToday = archiveDb.prepare("SELECT COUNT(*) AS count FROM download_job WHERE status = 'complete' AND date(completed_at) = date('now')").get() as { count: number };
  const failedToday = archiveDb.prepare("SELECT COUNT(*) AS count FROM download_job WHERE status = 'failed' AND date(updated_at) = date('now')").get() as { count: number };
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
  res.json(GetSystemDependenciesResponse.parse(dependencies.map(detectDependency)));
});

router.get("/system/events", (_req, res) => {
  res.json(GetSystemEventsResponse.parse(readEvents()));
});

export default router;