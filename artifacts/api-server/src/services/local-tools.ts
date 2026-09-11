import type { SettingsRecord } from "../lib/archive-db";
import { runtimeConfig } from "../lib/runtime-config";

export type LocalToolPaths = {
  ytDlp: string;
  ffmpeg: string;
  ffprobe: string;
};

function resolveTool(
  configured: string,
  fallback: string,
  managedDefault: string,
) {
  const value = configured.trim();
  if (
    value &&
    value !== fallback &&
    !(process.platform === "win32" && value === `${fallback}.exe`)
  ) {
    return value;
  }
  return managedDefault;
}

export function getLocalToolPaths(settings: Pick<SettingsRecord, "ytDlpPath" | "ffmpegPath" | "ffprobePath">): LocalToolPaths {
  return {
    ytDlp: resolveTool(settings.ytDlpPath, "yt-dlp", runtimeConfig.tools.ytDlp),
    ffmpeg: resolveTool(settings.ffmpegPath, "ffmpeg", runtimeConfig.tools.ffmpeg),
    ffprobe: resolveTool(settings.ffprobePath, "ffprobe", runtimeConfig.tools.ffprobe),
  };
}