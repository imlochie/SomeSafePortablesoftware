import type { SettingsRecord } from "../lib/archive-db";

export type LocalToolPaths = {
  ytDlp: string;
  ffmpeg: string;
  ffprobe: string;
};

export function getLocalToolPaths(settings: Pick<SettingsRecord, "ytDlpPath" | "ffmpegPath" | "ffprobePath">): LocalToolPaths {
  return {
    ytDlp: settings.ytDlpPath.trim() || "yt-dlp",
    ffmpeg: settings.ffmpegPath.trim() || "ffmpeg",
    ffprobe: settings.ffprobePath.trim() || "ffprobe",
  };
}