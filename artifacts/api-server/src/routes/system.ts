import { execFileSync } from "node:child_process";
import { Router, type IRouter } from "express";
import {
  GetSystemDependenciesResponse,
  GetSystemEventsResponse,
  GetSystemOverviewResponse,
} from "@workspace/api-zod";
import { readEvents, readSettings } from "../lib/archive-db";

const router: IRouter = Router();

const dependencies = [
  { name: "Node.js", command: "node", args: ["--version"] },
  { name: "SQLite", command: "sqlite3", args: ["--version"] },
  { name: "FFmpeg", command: "ffmpeg", args: ["-version"] },
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
    return {
      name: dependency.name,
      command: dependency.command,
      status: "available" as const,
      detail: "Detected on this machine",
      version,
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

router.get("/system/overview", (_req, res) => {
  const settings = readSettings();
  const events = readEvents(8);
  const payload = GetSystemOverviewResponse.parse({
    archiveStatus: "ready",
    plexStatus: "placeholder",
    queueStatus: "idle",
    processingStatus: "placeholder",
    storageStatus: "ready",
    aiStatus: settings.mockMode ? "placeholder" : "unavailable",
    lastSync: null,
    activity: events,
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