import { spawn, type ChildProcess, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { archiveDb, addEvent, readSettings, type SettingsRecord } from "../lib/archive-db";
import { inspectLocalMedia, prepareDownload, validateFormatId } from "./media";
import { getLocalToolPaths } from "./local-tools";

const execFileAsync = promisify(execFile);
type JobStatus =
  | "queued" | "inspecting" | "downloading" | "downloaded" | "processing"
  | "verifying" | "moving" | "complete" | "failed" | "cancelled" | "paused" | "recovery_required";
type Managed = { child?: ChildProcess; timer?: ReturnType<typeof setInterval>; cancelled?: boolean };
const active = new Map<number, Managed>();
const subscribers = new Set<(event: { type: string; job: ReturnType<typeof readJob> }) => void>();

export function subscribeDownloadEvents(listener: (event: { type: string; job: ReturnType<typeof readJob> }) => void) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function emit(type: string, jobId: number) {
  const job = readJob(jobId);
  if (!job) return;
  for (const listener of subscribers) listener({ type, job });
}

function readJob(id: number) {
  const row = archiveDb.prepare("SELECT * FROM download_job WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? toJob(row) : null;
}

export function readJobs() {
  const rows = archiveDb.prepare("SELECT * FROM download_job ORDER BY CASE status WHEN 'downloading' THEN 0 WHEN 'processing' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, created_at DESC").all() as Array<Record<string, unknown>>;
  return rows.map(toJob);
}

function toJob(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    sourceUrl: String(row.source_url ?? row.url ?? ""),
    sourceSite: (row.source_site as string | null) ?? null,
    sourceId: (row.source_id_text as string | null) ?? null,
    title: String(row.title ?? "Untitled media"),
    selectedFormatId: String(row.selected_format_id ?? "best"),
    selectedVideoFormatId: (row.selected_video_format_id as string | null) ?? null,
    selectedAudioFormatId: (row.selected_audio_format_id as string | null) ?? null,
    outputContainer: String(row.output_container ?? "mp4"),
    temporaryDirectory: String(row.temporary_directory ?? ""),
    destinationDirectory: String(row.destination_directory ?? ""),
    finalFilename: String(row.final_filename ?? "download"),
    finalPath: (row.final_path as string | null) ?? null,
    status: String(row.status ?? "queued") as JobStatus,
    progress: Number(row.progress ?? 0),
    downloadedBytes: Number(row.downloaded_bytes ?? 0),
    totalBytes: row.total_bytes == null ? null : Number(row.total_bytes),
    downloadSpeed: row.download_speed == null ? null : Number(row.download_speed),
    etaSeconds: row.eta_seconds == null ? null : Number(row.eta_seconds),
    createdAt: String(row.created_at),
    startedAt: (row.started_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    retryCount: Number(row.retry_count ?? 0),
    processId: row.process_id == null ? null : Number(row.process_id),
    currentPhase: String(row.current_phase ?? row.status ?? "queued"),
    verification: String(row.verification ?? "waiting") as "waiting" | "passed" | "failed" | "not_required",
  };
}

function updateJob(id: number, updates: Record<string, unknown>) {
  const entries = Object.entries(updates);
  if (!entries.length) return;
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  archiveDb.prepare(`UPDATE download_job SET ${set}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    ...entries.map(([, value]) => value as string | number | null | Uint8Array),
    id,
  );
  emit("job.updated", id);
}

function setStatus(id: number, status: JobStatus, updates: Record<string, unknown> = {}) {
  updateJob(id, { status, current_phase: status, ...updates });
}

function activeCount() {
  return [...active.values()].filter((managed) => managed.child || managed.timer).length;
}

function parseBytes(value: string | undefined) {
  if (!value) return null;
  const match = value.match(/([\d.]+)\s*(KiB|MiB|GiB|B)/i);
  if (!match) return null;
  const units = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };
  return Math.round(Number(match[1]) * (units[match[2].toLowerCase() as keyof typeof units] ?? 1));
}

function handleProgress(id: number, text: string) {
  const percentage = text.match(/(\d+(?:\.\d+)?)%/);
  const downloaded = parseBytes(text.match(/of\s+([\d.]+\s*(?:KiB|MiB|GiB|B))/i)?.[1]);
  const speed = text.match(/at\s+([\d.]+\s*(?:KiB|MiB|GiB|B)\/s)/i)?.[1];
  const eta = text.match(/ETA\s+(\d+:\d+)/i)?.[1];
  const etaSeconds = eta ? eta.split(":").reduce((total, part) => total * 60 + Number(part), 0) : null;
  updateJob(id, {
    ...(percentage ? { progress: Math.min(99, Number(percentage[1])) } : {}),
    ...(downloaded == null ? {} : { downloaded_bytes: downloaded }),
    ...(speed ? { download_speed: parseBytes(speed.replace("/s", "")) } : {}),
    ...(etaSeconds == null ? {} : { eta_seconds: etaSeconds }),
  });
}

async function verifyAndMove(id: number, inputPath: string, job: ReturnType<typeof readJob>, settings: SettingsRecord) {
  if (!job) throw new Error("Download job disappeared before verification.");
  setStatus(id, "verifying", { progress: 88 });
  const inspected = await inspectLocalMedia(inputPath, settings);
  if (inspected.verification !== "passed" || inspected.videoStreams + inspected.audioStreams < 1) {
    throw new Error("FFprobe could not verify the downloaded media streams.");
  }
  setStatus(id, "moving", { progress: 94, verification: "passed" });
  await fs.mkdir(job.destinationDirectory, { recursive: true });
  const finalPath = join(job.destinationDirectory, job.finalFilename);
  try {
    await fs.access(finalPath);
    throw new Error("The destination already contains a file with this name.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.rename(inputPath, finalPath);
  setStatus(id, "complete", {
    progress: 100,
    final_path: finalPath,
    completed_at: new Date().toISOString(),
    error_message: null,
    process_id: null,
  });
  addEvent("success", `Download complete: ${job.title}`, "download-engine");
  emit("job.completed", id);
}

async function processWithFfmpeg(id: number, inputPath: string, job: ReturnType<typeof readJob>) {
  if (!job) throw new Error("Download job disappeared before processing.");
  setStatus(id, "processing", { progress: 76 });
  const processedPath = join(job.temporaryDirectory, `.processed-${job.id}.${job.outputContainer}`);
  const { ffmpeg } = getLocalToolPaths(readSettings());
  await execFileAsync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", inputPath,
    "-map", "0",
    "-c", "copy",
    processedPath,
  ], { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  await fs.rm(inputPath, { force: true });
  return processedPath;
}

function formatExpression(job: ReturnType<typeof readJob>) {
  if (!job) return "best";
  const video = job.selectedVideoFormatId ? validateFormatId(job.selectedVideoFormatId) : null;
  const audio = job.selectedAudioFormatId ? validateFormatId(job.selectedAudioFormatId) : null;
  if (video && audio && video !== audio) return `${video}+${audio}`;
  return validateFormatId(job.selectedFormatId);
}

async function runRealJob(id: number, settings: SettingsRecord) {
  const job = readJob(id);
  if (!job) return;
  const managed: Managed = {};
  active.set(id, managed);
  try {
    await fs.mkdir(job.temporaryDirectory, { recursive: true });
    await fs.mkdir(job.destinationDirectory, { recursive: true });
    setStatus(id, "downloading", { started_at: new Date().toISOString(), error_message: null, verification: "waiting", process_id: null });
    const args = [
      "--newline", "--no-color", "--no-playlist", "--continue", "--no-overwrites",
      "--paths", job.temporaryDirectory,
      "--output", job.finalFilename,
      "--format", formatExpression(job),
      "--merge-output-format", job.outputContainer,
      "--retries", String(settings.maxRetries),
      "--fragment-retries", String(settings.maxRetries),
    ];
    if (settings.bandwidthLimit > 0) args.push("--limit-rate", `${settings.bandwidthLimit}B`);
    args.push(job.sourceUrl);
    const { ytDlp } = getLocalToolPaths(settings);
    const child = spawn(ytDlp, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    managed.child = child;
    updateJob(id, { process_id: child.pid ?? null });
    const onOutput = (chunk: Buffer) => handleProgress(id, chunk.toString());
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    const exitCode = await new Promise<number>((resolveExit) => {
      child.once("error", () => resolveExit(-1));
      child.once("close", (code) => resolveExit(code ?? -1));
    });
    if (managed.cancelled) return;
    if (exitCode !== 0) throw new Error(`yt-dlp exited with code ${exitCode}. Check the event log for source details.`);
    setStatus(id, "downloaded", { progress: 72, process_id: null });
    const expected = join(job.temporaryDirectory, job.finalFilename);
    let inputPath = expected;
    try {
      await fs.access(inputPath);
    } catch {
      const files = await fs.readdir(job.temporaryDirectory);
      const candidate = files.find((file) => file.startsWith(basename(job.finalFilename).replace(/\.[^.]+$/, "")) && !file.endsWith(".part"));
      if (!candidate) throw new Error("yt-dlp completed but no finished media file was found in the temporary directory.");
      inputPath = join(job.temporaryDirectory, candidate);
    }
    const processedPath = await processWithFfmpeg(id, inputPath, readJob(id));
    await verifyAndMove(id, processedPath, readJob(id), settings);
  } catch (error) {
    if (managed.cancelled) return;
    const current = readJob(id);
    const retries = current?.retryCount ?? 0;
    if (retries < settings.maxRetries) {
      updateJob(id, { retry_count: retries + 1, error_message: error instanceof Error ? error.message : "Download failed; retry scheduled." });
      setStatus(id, "queued");
      addEvent("warning", `Retry scheduled for ${current?.title ?? "download"} (${retries + 1}/${settings.maxRetries})`, "download-engine");
      setTimeout(() => void startJob(id), 500);
    } else {
      setStatus(id, "failed", { error_message: error instanceof Error ? error.message : "Download failed.", process_id: null, verification: "failed" });
      addEvent("error", `Download failed: ${current?.title ?? "download"}`, "download-engine");
    }
  } finally {
    active.delete(id);
    emit("job.finished", id);
  }
}

async function runMockJob(id: number) {
  const managed: Managed = {};
  active.set(id, managed);
  setStatus(id, "downloading", { started_at: new Date().toISOString(), error_message: null, verification: "waiting" });
  let tick = 0;
  managed.timer = setInterval(() => {
    tick += 1;
    const progress = Math.min(100, tick * 12.5);
    if (tick < 5) updateJob(id, { progress, downloaded_bytes: Math.round(progress * 1_200_000), total_bytes: 9_600_000, download_speed: 1_800_000, eta_seconds: Math.max(0, Math.round((100 - progress) / 12.5)) });
    else if (tick === 5) setStatus(id, "processing", { progress: 68 });
    else if (tick === 6) setStatus(id, "verifying", { progress: 84 });
    else if (tick === 7) setStatus(id, "moving", { progress: 94, verification: "passed" });
    else {
      if (managed.timer) clearInterval(managed.timer);
      const job = readJob(id);
      setStatus(id, "complete", { progress: 100, downloaded_bytes: 9_600_000, total_bytes: 9_600_000, completed_at: new Date().toISOString(), final_path: job ? join(job.destinationDirectory, job.finalFilename) : null, verification: "passed" });
      addEvent("success", `Demo download complete: ${job?.title ?? "download"}`, "download-engine");
      active.delete(id);
      emit("job.completed", id);
    }
  }, 650);
}

export function createJob(input: Parameters<typeof prepareDownload>[0], settings = readSettings()) {
  const spec = prepareDownload(input, settings);
  const result = archiveDb.prepare(`
    INSERT INTO download_job
      (source_id, url, source_url, source_site, title, selected_format_id, selected_video_format_id, selected_audio_format_id,
       output_container, temporary_directory, destination_directory, final_filename, status, progress, downloaded_bytes, current_phase, verification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, 'queued', 'waiting')
  `).run(null, spec.sourceUrl, spec.sourceUrl, spec.sourceSite, spec.title, spec.selectedFormatId, spec.selectedVideoFormatId, spec.selectedAudioFormatId, spec.outputContainer, spec.temporaryDirectory, spec.destinationDirectory, spec.finalFilename);
  const id = Number(result.lastInsertRowid);
  const maxPosition = archiveDb.prepare("SELECT COALESCE(MAX(position), 0) AS position FROM queue_item").get() as { position: number };
  archiveDb.prepare("INSERT INTO queue_item (job_type, job_id, position, status) VALUES ('download', ?, ?, 'queued')").run(id, maxPosition.position + 1);
  addEvent("info", `Queued download: ${spec.title}`, "download-engine");
  emit("job.created", id);
  return readJob(id);
}

export function startJob(id: number) {
  const job = readJob(id);
  if (!job) throw new Error("Download job not found.");
  if (active.has(id)) return job;
  if (!["queued", "paused", "recovery_required", "failed"].includes(job.status)) {
    if (job.status === "complete") return job;
    throw new Error(`Cannot start a job in ${job.status} state.`);
  }
  const settings = readSettings();
  if (activeCount() >= settings.concurrentDownloads) {
    addEvent("warning", `Concurrency limit reached; ${job.title} remains queued`, "download-engine");
    return job;
  }
  updateJob(id, { retry_count: job.status === "failed" ? job.retryCount : job.retryCount, error_message: null });
  if (settings.mockMode) void runMockJob(id);
  else void runRealJob(id, settings);
  return readJob(id);
}

export const resumeJob = startJob;

export function pauseJob(id: number) {
  const job = readJob(id);
  const managed = active.get(id);
  if (!job) throw new Error("Download job not found.");
  if (!managed) return job;
  managed.cancelled = true;
  if (managed.timer) clearInterval(managed.timer);
  if (managed.child) managed.child.kill("SIGTERM");
  active.delete(id);
  setStatus(id, "paused", { process_id: null, error_message: null });
  addEvent("info", `Paused download: ${job.title}`, "download-engine");
  return readJob(id);
}

export function cancelJob(id: number) {
  const job = readJob(id);
  const managed = active.get(id);
  if (!job) throw new Error("Download job not found.");
  if (managed) {
    managed.cancelled = true;
    if (managed.timer) clearInterval(managed.timer);
    if (managed.child) managed.child.kill("SIGTERM");
    active.delete(id);
  }
  if (job.status !== "complete") setStatus(id, "cancelled", { process_id: null, error_message: null });
  addEvent("info", `Cancelled download: ${job.title}`, "download-engine");
  return readJob(id);
}

export function retryJob(id: number) {
  const job = readJob(id);
  if (!job) throw new Error("Download job not found.");
  if (!["failed", "cancelled", "paused", "recovery_required"].includes(job.status)) throw new Error("Only failed, cancelled, paused, or recoverable jobs can be retried.");
  updateJob(id, { retry_count: 0, error_message: null, progress: 0, downloaded_bytes: 0, completed_at: null, final_path: null, verification: "waiting" });
  setStatus(id, "queued");
  return startJob(id);
}

export function deleteJob(id: number) {
  const job = readJob(id);
  if (!job) throw new Error("Download job not found.");
  if (active.has(id) || ["downloading", "processing", "verifying", "moving"].includes(job.status)) throw new Error("Stop the running job before deleting it.");
  archiveDb.prepare("DELETE FROM queue_item WHERE job_type = 'download' AND job_id = ?").run(id);
  archiveDb.prepare("DELETE FROM download_job WHERE id = ?").run(id);
  addEvent("info", `Removed queued download: ${job.title}`, "download-engine");
}

// A process that was active before a local restart cannot safely be resumed in-place.
archiveDb.prepare("UPDATE download_job SET status = 'recovery_required', current_phase = 'recovery_required', error_message = 'The application restarted before this job finished.', process_id = NULL WHERE status IN ('inspecting', 'downloading', 'downloaded', 'processing', 'verifying', 'moving')").run();