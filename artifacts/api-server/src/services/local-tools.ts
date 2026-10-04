import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import type { SettingsRecord } from "../lib/archive-db";
import { runtimeConfig } from "../lib/runtime-config";

const execFileAsync = promisify(execFile);

export type LocalToolPaths = {
  ytDlp: string;
  ffmpeg: string;
  ffprobe: string;
};

/**
 * Executes a configured local tool.
 *
 * Plain executables run directly. JavaScript tools (.js/.mjs/.cjs) run
 * through the current Node executable: Windows cannot execute a script file
 * directly, and POSIX needs neither a shebang nor the executable bit when the
 * Node runtime that manages the tool is already running. This is the same
 * convention this repository uses to invoke its own .mjs entrypoints on
 * Windows.
 */
export function runLocalTool(toolPath: string, args: string[], options: ExecFileOptions = {}) {
  // execFile already defaults to utf8 strings; pinning it keeps the helper's
  // resolved overload the same as the previous direct calls.
  const toolOptions: ExecFileOptions & { encoding: "utf8" } = { ...options, encoding: "utf8" };
  if (/\.(?:c|m)?js$/i.test(toolPath)) {
    return execFileAsync(process.execPath, [toolPath, ...args], toolOptions);
  }
  return execFileAsync(toolPath, args, toolOptions);
}

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