import { spawn, type ChildProcess, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { moveFile } from "../lib/fs-move";
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
const subscribers = new Set<{
  ownerId: string;
  listener: (event: { type: string; job: ReturnType<typeof readJob> }) => void;
}>();

export function subscribeDownloadEvents(ownerId: string, listener: (event: { type: string; job: ReturnType<typeof readJob> }) => void) {
  const subscription = { ownerId, listener };
  subscribers.add(subscription);
  return () => subscribers.delete(subscription);
}

function emit(type: string, jobId: number, ownerId: string) {
  const job = readJob(jobId, ownerId);
  if (!job) return;
  for (const subscriber of subscribers) {
    if (subscriber.ownerId === ownerId) subscriber.listener({ type, job });
  }
}

function readJob(id: number, ownerId: string) {
  const row = archiveDb.prepare("SELECT * FROM download_job WHERE id = ? AND owner_id = ?").get(id, ownerId) as Record<string, unknown> | undefined;
  return row ? toJob(row) : null;
}

export function readJobs(ownerId: string) {
  const rows = archiveDb.prepare("SELECT * FROM download_job WHERE owner_id = ? ORDER BY CASE status WHEN 'downloading' THEN 0 WHEN 'processing' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, created_at DESC").all(ownerId) as Array<Record<string, unknown>>;
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

function updateJob(id: number, ownerId: string, updates: Record<string, unknown>) {
  const entries = Object.entries(updates);
  if (!entries.length) return;
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  const result = archiveDb.prepare(`UPDATE download_job SET ${set}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?`).run(
    ...entries.map(([, value]) => value as string | number | null | Uint8Array),
    id,
    ownerId,
  );
  if (result.changes === 0) throw new Error("Download job not found.");
  emit("job.updated", id, ownerId);
}

function setStatus(id: number, ownerId: string, status: JobStatus, updates: Record<string, unknown> = {}) {
  updateJob(id, ownerId, { status, current_phase: status, ...updates });
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

function handleProgress(id: number, ownerId: string, text: string) {
  const percentage = text.match(/(\d+(?:\.\d+)?)%/);
  const downloaded = parseBytes(text.match(/of\s+([\d.]+\s*(?:KiB|MiB|GiB|B))/i)?.[1]);
  const speed = text.match(/at\s+([\d.]+\s*(?:KiB|MiB|GiB|B)\/s)/i)?.[1];
  const eta = text.match(/ETA\s+(\d+:\d+)/i)?.[1];
  const etaSeconds = eta ? eta.split(":").reduce((total, part) => total * 60 + Number(part), 0) : null;
  updateJob(id, ownerId, {
    ...(percentage ? { progress: Math.min(99, Number(percentage[1])) } : {}),
    ...(downloaded == null ? {} : { downloaded_bytes: downloaded }),
    ...(speed ? { download_speed: parseBytes(speed.replace("/s", "")) } : {}),
    ...(etaSeconds == null ? {} : { eta_seconds: etaSeconds }),
  });
}

async function verifyAndMove(id: number, ownerId: string, inputPath: string, job: ReturnType<typeof readJob>, settings: SettingsRecord) {
  if (!job) throw new Error("Download job disappeared before verification.");
  setStatus(id, ownerId, "verifying", { progress: 88 });
  const inspected = await inspectLocalMedia(inputPath, settings);
  if (inspected.verification !== "passed" || inspected.videoStreams + inspected.audioStreams < 1) {
    throw new Error("FFprobe could not verify the downloaded media streams.");
  }
  setStatus(id, ownerId, "moving", { progress: 94, verification: "passed" });
  await fs.mkdir(job.destinationDirectory, { recursive: true });
  const finalPath = join(job.destinationDirectory, job.finalFilename);
  try {
    await fs.access(finalPath);
    throw new Error("The destination already contains a file with this name.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await moveFile(inputPath, finalPath);
  setStatus(id, ownerId, "complete", {
    progress: 100,
    final_path: finalPath,
    completed_at: new Date().toISOString(),
    error_message: null,
    process_id: null,
  });
  addEvent("success", `Download complete: ${job.title}`, "download-engine", ownerId);
  emit("job.completed", id, ownerId);
}

async function processWithFfmpeg(id: number, ownerId: string, inputPath: string, job: ReturnType<typeof readJob>) {
  if (!job) throw new Error("Download job disappeared before processing.");
  setStatus(id, ownerId, "processing", { progress: 76 });
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

async function runRealJob(id: number, ownerId: string, settings: SettingsRecord) {
  const job = readJob(id, ownerId);
  if (!job) return;
  const managed: Managed = {};
  active.set(id, managed);
  try {
    await fs.mkdir(job.temporaryDirectory, { recursive: true });
    await fs.mkdir(job.destinationDirectory, { recursive: true });
    setStatus(id, ownerId, "downloading", { started_at: new Date().toISOString(), error_message: null, verification: "waiting", process_id: null });
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
    updateJob(id, ownerId, { process_id: child.pid ?? null });
    const onOutput = (chunk: Buffer) => handleProgress(id, ownerId, chunk.toString());
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    const exitCode = await new Promise<number>((resolveExit) => {
      child.once("error", () => resolveExit(-1));
      child.once("close", (code) => resolveExit(code ?? -1));
    });
    if (managed.cancelled) return;
    if (exitCode !== 0) throw new Error(`yt-dlp exited with code ${exitCode}. Check the event log for source details.`);
    setStatus(id, ownerId, "downloaded", { progress: 72, process_id: null });
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
    const processedPath = await processWithFfmpeg(id, ownerId, inputPath, readJob(id, ownerId));
    await verifyAndMove(id, ownerId, processedPath, readJob(id, ownerId), settings);
  } catch (error) {
    if (managed.cancelled) return;
    const current = readJob(id, ownerId);
    const retries = current?.retryCount ?? 0;
    if (retries < settings.maxRetries) {
      updateJob(id, ownerId, { retry_count: retries + 1, error_message: error instanceof Error ? error.message : "Download failed; retry scheduled." });
      setStatus(id, ownerId, "queued");
      addEvent("warning", `Retry scheduled for ${current?.title ?? "download"} (${retries + 1}/${settings.maxRetries})`, "download-engine", ownerId);
      setTimeout(() => void startJob(id, ownerId), 500);
    } else {
      setStatus(id, ownerId, "failed", { error_message: error instanceof Error ? error.message : "Download failed.", process_id: null, verification: "failed" });
      addEvent("error", `Download failed: ${current?.title ?? "download"}`, "download-engine", ownerId);
    }
  } finally {
    active.delete(id);
    emit("job.finished", id, ownerId);
  }
}

async function runMockJob(id: number, ownerId: string) {
  const managed: Managed = {};
  active.set(id, managed);
  setStatus(id, ownerId, "downloading", { started_at: new Date().toISOString(), error_message: null, verification: "waiting" });
  let tick = 0;
  managed.timer = setInterval(() => {
    tick += 1;
    const progress = Math.min(100, tick * 12.5);
    if (tick < 5) updateJob(id, ownerId, { progress, downloaded_bytes: Math.round(progress * 1_200_000), total_bytes: 9_600_000, download_speed: 1_800_000, eta_seconds: Math.max(0, Math.round((100 - progress) / 12.5)) });
    else if (tick === 5) setStatus(id, ownerId, "processing", { progress: 68 });
    else if (tick === 6) setStatus(id, ownerId, "verifying", { progress: 84 });
    else if (tick === 7) setStatus(id, ownerId, "moving", { progress: 94, verification: "passed" });
    else {
      if (managed.timer) clearInterval(managed.timer);
      const job = readJob(id, ownerId);
      setStatus(id, ownerId, "complete", { progress: 100, downloaded_bytes: 9_600_000, total_bytes: 9_600_000, completed_at: new Date().toISOString(), final_path: job ? join(job.destinationDirectory, job.finalFilename) : null, verification: "passed" });
      addEvent("success", `Demo download complete: ${job?.title ?? "download"}`, "download-engine", ownerId);
      active.delete(id);
      emit("job.completed", id, ownerId);
    }
  }, 650);
}

export function createJob(input: Parameters<typeof prepareDownload>[0], ownerId: string, settings = readSettings()) {
  const spec = prepareDownload(input, settings);
  const result = archiveDb.prepare(`
    INSERT INTO download_job
      (source_id, url, source_url, source_site, title, selected_format_id, selected_video_format_id, selected_audio_format_id,
       output_container, temporary_directory, destination_directory, final_filename, owner_id, status, progress, downloaded_bytes, current_phase, verification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, 'queued', 'waiting')
  `).run(null, spec.sourceUrl, spec.sourceUrl, spec.sourceSite, spec.title, spec.selectedFormatId, spec.selectedVideoFormatId, spec.selectedAudioFormatId, spec.outputContainer, spec.temporaryDirectory, spec.destinationDirectory, spec.finalFilename, ownerId);
  const id = Number(result.lastInsertRowid);
  const maxPosition = archiveDb.prepare("SELECT COALESCE(MAX(q.position), 0) AS position FROM queue_item q JOIN download_job j ON j.id = q.job_id WHERE q.job_type = 'download' AND j.owner_id = ?").get(ownerId) as { position: number };
  archiveDb.prepare("INSERT INTO queue_item (job_type, job_id, position, status) VALUES ('download', ?, ?, 'queued')").run(id, maxPosition.position + 1);
  addEvent("info", `Queued download: ${spec.title}`, "download-engine", ownerId);
  emit("job.created", id, ownerId);
  return readJob(id, ownerId);
}

export function startJob(id: number, ownerId: string) {
  const job = readJob(id, ownerId);
  if (!job) throw new Error("Download job not found.");
  if (active.has(id)) return job;
  if (!["queued", "paused", "recovery_required", "failed"].includes(job.status)) {
    if (job.status === "complete") return job;
    throw new Error(`Cannot start a job in ${job.status} state.`);
  }
  const settings = readSettings();
  if (activeCount() >= settings.concurrentDownloads) {
    addEvent("warning", `Concurrency limit reached; ${job.title} remains queued`, "download-engine", ownerId);
    return job;
  }
  updateJob(id, ownerId, { retry_count: job.status === "failed" ? job.retryCount : job.retryCount, error_message: null });
  if (settings.mockMode) void runMockJob(id, ownerId);
  else void runRealJob(id, ownerId, settings);
  return readJob(id, ownerId);
}

export const resumeJob = startJob;

export function pauseJob(id: number, ownerId: string) {
  const job = readJob(id, ownerId);
  const managed = active.get(id);
  if (!job) throw new Error("Download job not found.");
  if (!managed) return job;
  managed.cancelled = true;
  if (managed.timer) clearInterval(managed.timer);
  if (managed.child) managed.child.kill("SIGTERM");
  active.delete(id);
  setStatus(id, ownerId, "paused", { process_id: null, error_message: null });
  addEvent("info", `Paused download: ${job.title}`, "download-engine", ownerId);
  return readJob(id, ownerId);
}

export function cancelJob(id: number, ownerId: string) {
  const job = readJob(id, ownerId);
  const managed = active.get(id);
  if (!job) throw new Error("Download job not found.");
  if (managed) {
    managed.cancelled = true;
    if (managed.timer) clearInterval(managed.timer);
    if (managed.child) managed.child.kill("SIGTERM");
    active.delete(id);
  }
  if (job.status !== "complete") setStatus(id, ownerId, "cancelled", { process_id: null, error_message: null });
  addEvent("info", `Cancelled download: ${job.title}`, "download-engine", ownerId);
  return readJob(id, ownerId);
}

export function retryJob(id: number, ownerId: string) {
  const job = readJob(id, ownerId);
  if (!job) throw new Error("Download job not found.");
  if (!["failed", "cancelled", "paused", "recovery_required"].includes(job.status)) throw new Error("Only failed, cancelled, paused, or recoverable jobs can be retried.");
  updateJob(id, ownerId, { retry_count: 0, error_message: null, progress: 0, downloaded_bytes: 0, completed_at: null, final_path: null, verification: "waiting" });
  setStatus(id, ownerId, "queued");
  return startJob(id, ownerId);
}

export function deleteJob(id: number, ownerId: string) {
  const job = readJob(id, ownerId);
  if (!job) throw new Error("Download job not found.");
  if (active.has(id) || ["downloading", "processing", "verifying", "moving"].includes(job.status)) throw new Error("Stop the running job before deleting it.");
  archiveDb.prepare("DELETE FROM queue_item WHERE job_type = 'download' AND job_id = ?").run(id);
  archiveDb.prepare("DELETE FROM download_job WHERE id = ?").run(id);
  addEvent("info", `Removed queued download: ${job.title}`, "download-engine", ownerId);
}

// A process that was active before a local restart cannot safely be resumed in-place.
archiveDb.prepare("UPDATE download_job SET status = 'recovery_required', current_phase = 'recovery_required', error_message = 'The application restarted before this job finished.', process_id = NULL WHERE status IN ('inspecting', 'downloading', 'downloaded', 'processing', 'verifying', 'moving')").run();