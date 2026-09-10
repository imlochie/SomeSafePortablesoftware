import { execFileSync } from "node:child_process";
import type { SettingsRecord } from "../lib/archive-db";
import { getLocalToolPaths } from "./local-tools";

export const dependencyDefinitions = [
  { name: "Node.js", key: null, fallback: "node", args: ["--version"] },
  { name: "SQLite", key: null, fallback: "sqlite3", args: ["--version"] },
  { name: "FFmpeg", key: "ffmpeg", fallback: "ffmpeg", args: ["-version"] },
  { name: "ffprobe", key: "ffprobe", fallback: "ffprobe", args: ["-version"] },
  { name: "yt-dlp", key: "ytDlp", fallback: "yt-dlp", args: ["--version"] },
] as const;

export function detectDependency(
  dependency: (typeof dependencyDefinitions)[number],
  settings: SettingsRecord,
) {
  const tools = getLocalToolPaths(settings);
  const command = dependency.key ? tools[dependency.key] : dependency.fallback;
  try {
    const versionOutput = execFileSync(command, dependency.args, {
      encoding: "utf8",
      timeout: 1200,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const version = versionOutput.trim().split(/\r?\n/)[0] ?? null;
    const capabilities =
      dependency.name === "FFmpeg"
        ? detectFfmpegCapabilities(tools.ffmpeg)
        : [];
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
      status:
        dependency.name === "SQLite"
          ? ("not_configured" as const)
          : ("missing" as const),
      detail:
        dependency.name === "SQLite"
          ? "Using the embedded SQLite runtime"
          : "Optional dependency not detected",
      version: null,
      capabilities: [],
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
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.includes("Hardware acceleration"));
  } catch {
    return [];
  }
}