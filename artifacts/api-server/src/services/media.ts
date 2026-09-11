import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SettingsRecord } from "../lib/archive-db";
import { getLocalToolPaths } from "./local-tools";
import { technicalQualityFromProbe } from "./media-quality";
import {
  chooseArchiveVolume,
  ensureArchiveVolume,
  findArchiveVolumeForPath,
  getArchiveScanRoots,
  type ArchiveMediaType,
} from "./storage";

const execFileAsync = promisify(execFile);

export type NormalizedMediaFormat = {
  formatId: string;
  extension: string | null;
  protocol: string | null;
  width: number | null;
  height: number | null;
  resolution: string;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  filesize: number | null;
  estimatedFilesize: number | null;
  dynamicRange: string | null;
  audioLanguage: string | null;
  videoLanguage: string | null;
  container: string | null;
  videoOnly: boolean;
  audioOnly: boolean;
  muxed: boolean;
  manifestProtocol: string | null;
  hls: boolean;
  dash: boolean;
  usable: boolean;
  score: number;
};

export type MediaInspection = {
  metadata: {
    title: string;
    uploader: string | null;
    channel: string | null;
    description: string | null;
    durationSeconds: number | null;
    uploadDate: string | null;
    thumbnailUrl: string | null;
    webpageUrl: string;
    extractor: string | null;
    sourceId: string | null;
    playlistTitle: string | null;
    playlistIndex: number | null;
  };
  formats: NormalizedMediaFormat[];
  rawFormatCount: number;
  recommendedFormatId: string | null;
  recommendedVideoFormatId: string | null;
  recommendedAudioFormatId: string | null;
  recommendationExplanation: string;
  demoMode: boolean;
  cachedAt: string;
};

type RawFormat = Record<string, unknown>;
const inspectionCache = new Map<string, { expiresAt: number; value: MediaInspection }>();

const mockFormats: NormalizedMediaFormat[] = [
  makeFormat({
    format_id: "401",
    ext: "mp4",
    protocol: "https",
    width: 3840,
    height: 2160,
    fps: 60,
    vcodec: "av01.0.12M.10",
    acodec: "none",
    tbr: 18000,
    filesize_approx: 6_800_000_000,
    dynamic_range: "HDR10",
  }),
  makeFormat({
    format_id: "399",
    ext: "mp4",
    protocol: "https",
    width: 1920,
    height: 1080,
    fps: 60,
    vcodec: "avc1.64002a",
    acodec: "none",
    tbr: 5200,
    filesize_approx: 2_100_000_000,
  }),
  makeFormat({
    format_id: "248",
    ext: "webm",
    protocol: "https",
    width: 1920,
    height: 1080,
    fps: 30,
    vcodec: "vp9",
    acodec: "none",
    tbr: 4600,
    filesize_approx: 1_800_000_000,
  }),
  makeFormat({
    format_id: "18",
    ext: "mp4",
    protocol: "https",
    width: 640,
    height: 360,
    fps: 30,
    vcodec: "avc1.42001e",
    acodec: "mp4a.40.2",
    tbr: 850,
    filesize: 320_000_000,
  }),
  makeFormat({
    format_id: "251",
    ext: "webm",
    protocol: "https",
    abr: 160,
    vcodec: "none",
    acodec: "opus",
    filesize_approx: 120_000_000,
    language: "en",
  }),
  makeFormat({
    format_id: "140",
    ext: "m4a",
    protocol: "https",
    abr: 128,
    vcodec: "none",
    acodec: "mp4a.40.2",
    filesize_approx: 95_000_000,
    language: "en",
  }),
];

/**
 * FFprobe reports `duration` and `bit_rate` as decimal strings, so numeric
 * strings are accepted here. Strict `typeof === "number"` parsing silently
 * dropped the duration and bitrate of every probed file, which starved the
 * quality model of the two axes duplicates are judged on.
 */
function numberOrNull(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function codecWeight(codec: string | null) {
  if (!codec || codec === "none") return 0;
  if (codec.includes("av01") || codec.includes("av1")) return 90;
  if (codec.includes("hevc") || codec.includes("hvc1")) return 86;
  if (codec.includes("vp9")) return 78;
  if (codec.includes("avc") || codec.includes("h264")) return 70;
  return 55;
}

function makeFormat(raw: RawFormat): NormalizedMediaFormat {
  const formatId = String(raw.format_id ?? "unknown");
  const extension = stringOrNull(raw.ext);
  const protocol = stringOrNull(raw.protocol);
  const width = numberOrNull(raw.width);
  const height = numberOrNull(raw.height);
  const videoCodec = stringOrNull(raw.vcodec);
  const audioCodec = stringOrNull(raw.acodec);
  const bitrate = numberOrNull(raw.tbr ?? raw.vbr ?? raw.abr);
  const filesize = numberOrNull(raw.filesize);
  const estimatedFilesize = numberOrNull(raw.filesize_approx);
  const videoOnly = Boolean(height || width) && (!audioCodec || audioCodec === "none");
  const audioOnly = !height && !width && Boolean(audioCodec && audioCodec !== "none");
  const muxed = Boolean(!videoOnly && !audioOnly && (height || width) && audioCodec && audioCodec !== "none");
  const manifestProtocol =
    protocol?.includes("m3u8") ? "HLS" : protocol?.includes("dash") ? "DASH" : null;
  const usable = Boolean(extension && (height || audioOnly || audioCodec));
  const heightScore = Math.min(height ?? 0, 4320) / 18;
  const codecScore = codecWeight(videoCodec);
  const audioScore = audioOnly ? Math.min(bitrate ?? 0, 320) / 5 : audioCodec && audioCodec !== "none" ? 20 : 0;
  const hdrScore = stringOrNull(raw.dynamic_range) ? 8 : 0;
  const manifestPenalty = manifestProtocol ? 2 : 0;
  const score = usable ? Math.round((heightScore + codecScore + audioScore + hdrScore - manifestPenalty) * 100) / 100 : 0;

  return {
    formatId,
    extension,
    protocol,
    width,
    height,
    resolution: height ? `${height}p` : audioOnly ? "Audio" : "Unknown",
    fps: numberOrNull(raw.fps),
    videoCodec,
    audioCodec,
    bitrate,
    filesize,
    estimatedFilesize,
    dynamicRange: stringOrNull(raw.dynamic_range),
    audioLanguage: stringOrNull(raw.language),
    videoLanguage: stringOrNull(raw.language),
    container: stringOrNull(raw.container ?? raw.ext),
    videoOnly,
    audioOnly,
    muxed,
    manifestProtocol,
    hls: Boolean(protocol?.includes("m3u8")),
    dash: Boolean(protocol?.includes("dash")),
    usable,
    score,
  };
}

function recommend(formats: NormalizedMediaFormat[]) {
  const usable = formats.filter((format) => format.usable);
  const video = usable
    .filter((format) => !format.audioOnly)
    .sort((a, b) => b.score - a.score || (b.height ?? 0) - (a.height ?? 0) || a.formatId.localeCompare(b.formatId));
  const audio = usable
    .filter((format) => format.audioOnly)
    .sort((a, b) => b.score - a.score || (b.bitrate ?? 0) - (a.bitrate ?? 0) || a.formatId.localeCompare(b.formatId));
  const bestVideo = video[0] ?? null;
  const bestAudio = audio[0] ?? null;
  const recommended = usable.find((format) => format.muxed) ?? bestVideo;
  if (!recommended) {
    return {
      recommendedFormatId: null,
      recommendedVideoFormatId: null,
      recommendedAudioFormatId: null,
      recommendationExplanation: "No usable video or audio format was returned by the source.",
    };
  }
  const separate = Boolean(bestVideo && !bestVideo.muxed && bestAudio);
  return {
    recommendedFormatId: recommended.formatId,
    recommendedVideoFormatId: bestVideo?.formatId ?? null,
    recommendedAudioFormatId: bestAudio?.formatId ?? null,
    recommendationExplanation: separate
      ? `Recommended ${bestVideo?.resolution ?? "video"} video plus ${bestAudio?.audioCodec ?? "audio"} audio. This preserves the strongest available quality and requires a local mux step.`
      : `Recommended ${recommended.resolution} ${recommended.videoCodec ?? "audio"} source because it is the highest-scoring usable muxed format.`,
  };
}

function buildInspection(url: string, raw: RawFormat[], metadata: Partial<MediaInspection["metadata"]>, demoMode: boolean): MediaInspection {
  const formats = raw.map(makeFormat).filter((format) => format.usable);
  return {
    metadata: {
      title: metadata.title ?? "Untitled media",
      uploader: metadata.uploader ?? null,
      channel: metadata.channel ?? null,
      description: metadata.description ?? null,
      durationSeconds: metadata.durationSeconds ?? null,
      uploadDate: metadata.uploadDate ?? null,
      thumbnailUrl: metadata.thumbnailUrl ?? null,
      webpageUrl: metadata.webpageUrl ?? url,
      extractor: metadata.extractor ?? null,
      sourceId: metadata.sourceId ?? null,
      playlistTitle: metadata.playlistTitle ?? null,
      playlistIndex: metadata.playlistIndex ?? null,
    },
    formats,
    rawFormatCount: raw.length,
    ...recommend(formats),
    demoMode,
    cachedAt: new Date().toISOString(),
  };
}

function validateSourceUrl(sourceUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("Enter a valid media URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("Only HTTP and HTTPS media URLs are supported.");
  }
  return parsed;
}

function expandPath(value: string) {
  return value.startsWith("~/") ? join(process.env.HOME ?? process.cwd(), value.slice(2)) : value;
}

export function isPathWithin(candidate: string, root: string) {
  const candidatePath = resolve(expandPath(candidate));
  const rootPath = resolve(expandPath(root));
  const insensitive = process.platform === "win32";
  const left = insensitive ? candidatePath.toLowerCase() : candidatePath;
  const right = insensitive ? rootPath.toLowerCase() : rootPath;
  return left === right || left.startsWith(`${right}${sep}`);
}

/**
 * Directories an operator configured, in preference order. Settings accept a
 * JSON array, newline-separated, or semicolon-separated list; the first entry
 * is the default when a request does not name one itself.
 */
export function configuredDirectoryRoots(configuredRoot: string): string[] {
  const roots: string[] = [];

  try {
    const parsed = JSON.parse(configuredRoot);

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "string" && item.trim()) {
          roots.push(item.trim());
        }
      }
    }
  } catch {
    // Fall through to newline/semicolon parsing.
  }

  if (!roots.length) {
    roots.push(
      ...configuredRoot
        .split(/\r?\n|;/)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }

  return roots;
}

export function validateSafeDirectory(
  candidate: string | undefined,
  configuredRoot: string,
  label: string,
) {
  const roots = configuredDirectoryRoots(configuredRoot);

  if (!roots.length) {
    throw new Error(`${label} is not configured.`);
  }

  const value = candidate?.trim();

  if (!value) {
    throw new Error(`${label} is required.`);
  }

  const target = resolve(value);

  const allowed = roots.some((root) => {
    const base = resolve(root);

    const normalizedTarget =
      process.platform === "win32"
        ? target.toLowerCase()
        : target;

    const normalizedBase =
      process.platform === "win32"
        ? base.toLowerCase()
        : base;

    return (
      normalizedTarget === normalizedBase ||
      normalizedTarget.startsWith(`${normalizedBase}${sep}`)
    );
  });

  if (!allowed) {
    throw new Error(
      `Local inspection is limited to configured Archive Assistant directories.`,
    );
  }

  return target;
}

export function sanitizeFilename(value: string, extension: string) {
  const base = basename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 180) || "download";
  const suffix = `.${extension.replace(/^\./, "")}`;
  return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : `${base}${suffix}`;
}

export function validateFormatId(value: string | undefined) {
  const id = value?.trim() || "best";
  if (!/^[a-zA-Z0-9+._-]{1,120}$/.test(id)) throw new Error("The selected format is invalid.");
  return id;
}

export async function inspectMediaSource(url: string, settings: SettingsRecord, forceRefresh = false) {
  const parsedUrl = validateSourceUrl(url);
  const cacheKey = parsedUrl.toString();
  const cached = inspectionCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;

  if (settings.mockMode) {
    const value = buildInspection(
      cacheKey,
      mockFormats.map((format) => ({
        format_id: format.formatId,
        ext: format.extension,
        protocol: format.protocol,
        width: format.width,
        height: format.height,
        fps: format.fps,
        vcodec: format.videoCodec,
        acodec: format.audioCodec,
        tbr: format.bitrate,
        filesize: format.filesize,
        filesize_approx: format.estimatedFilesize,
        dynamic_range: format.dynamicRange,
        language: format.audioLanguage,
      })),
      {
        title: "The Archive Assistant demo signal",
        uploader: "Local Demo Channel",
        channel: "Archive Assistant",
        description: "A deterministic media-source fixture for evaluating source selection and queue preparation.",
        durationSeconds: 742,
        uploadDate: "20260831",
        thumbnailUrl: null,
        webpageUrl: cacheKey,
        extractor: "demo",
        sourceId: "demo-source-001",
        playlistTitle: null,
        playlistIndex: null,
      },
      true,
    );
    inspectionCache.set(cacheKey, { expiresAt: Date.now() + settings.inspectionCacheMinutes * 60_000, value });
    return value;
  }

  const { ytDlp } = getLocalToolPaths(settings);
  const { stdout } = await execFileAsync(ytDlp, [
    "--dump-single-json",
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    cacheKey,
  ], { timeout: 60_000, maxBuffer: 25 * 1024 * 1024 });
  const rawInfo = JSON.parse(stdout) as Record<string, unknown>;
  const value = rawInfoToInspection(cacheKey, rawInfo);
  inspectionCache.set(cacheKey, { expiresAt: Date.now() + settings.inspectionCacheMinutes * 60_000, value });
  return value;
}

/** Shared normalization for one yt-dlp info object (single video or playlist entry). */
function rawInfoToInspection(url: string, rawInfo: Record<string, unknown>): MediaInspection {
  const rawFormats = Array.isArray(rawInfo.formats) ? rawInfo.formats as RawFormat[] : [];
  return buildInspection(url, rawFormats, {
    title: stringOrNull(rawInfo.title) ?? "Untitled media",
    uploader: stringOrNull(rawInfo.uploader),
    channel: stringOrNull(rawInfo.channel),
    description: stringOrNull(rawInfo.description),
    durationSeconds: numberOrNull(rawInfo.duration),
    uploadDate: stringOrNull(rawInfo.upload_date),
    thumbnailUrl: stringOrNull(rawInfo.thumbnail),
    webpageUrl: stringOrNull(rawInfo.webpage_url) ?? url,
    extractor: stringOrNull(rawInfo.extractor_key ?? rawInfo.extractor),
    sourceId: stringOrNull(rawInfo.id),
    playlistTitle: stringOrNull(rawInfo.playlist_title),
    playlistIndex: numberOrNull(rawInfo.playlist_index),
  }, false);
}

/**
 * Playlist-aware variant of the same yt-dlp inspection path: without
 * `--no-playlist`, yt-dlp reports the containing playlist with one info object
 * per entry. Each entry is normalized through the identical pipeline, so media
 * candidates and the /media/inspect endpoint can never disagree about what a
 * source contains. Entries are capped to keep planning bounded.
 */
export const PLAYLIST_ENTRY_LIMIT = 50;

export type MediaSourceInspection = MediaInspection & {
  entries: Array<MediaInspection & { entryUrl: string }>;
};

export async function inspectMediaSourceEntries(url: string, settings: SettingsRecord, forceRefresh = false): Promise<MediaSourceInspection> {
  const parsedUrl = validateSourceUrl(url);
  const cacheKey = `entries:${parsedUrl.toString()}`;
  const cached = inspectionCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value as MediaSourceInspection;

  const { ytDlp } = getLocalToolPaths(settings);
  const { stdout } = await execFileAsync(ytDlp, [
    "--dump-single-json",
    "--skip-download",
    "--no-warnings",
    parsedUrl.toString(),
  ], { timeout: 120_000, maxBuffer: 25 * 1024 * 1024 });
  const rawInfo = JSON.parse(stdout) as Record<string, unknown>;

  const rawEntries = Array.isArray(rawInfo.entries) ? rawInfo.entries as Array<Record<string, unknown>> : [];
  if (!rawEntries.length) {
    // A plain video URL: the payload itself is the single entry.
    const value = { ...rawInfoToInspection(parsedUrl.toString(), rawInfo), entries: [] };
    const single: MediaSourceInspection = {
      ...value,
      entries: [{ ...value, entryUrl: stringOrNull(rawInfo.webpage_url) ?? parsedUrl.toString() }],
    };
    inspectionCache.set(cacheKey, { expiresAt: Date.now() + settings.inspectionCacheMinutes * 60_000, value: single });
    return single;
  }

  const container = rawInfoToInspection(parsedUrl.toString(), { ...rawInfo, formats: [] });
  const entries = rawEntries.slice(0, PLAYLIST_ENTRY_LIMIT).map((entry, index) => {
    const entryUrl = stringOrNull(entry.webpage_url ?? entry.url) ?? `${parsedUrl.toString()}#entry=${index + 1}`;
    return { ...rawInfoToInspection(entryUrl, entry), entryUrl };
  });
  const value: MediaSourceInspection = {
    ...container,
    metadata: { ...container.metadata, title: container.metadata.title ?? "Untitled playlist" },
    entries,
  };
  inspectionCache.set(cacheKey, { expiresAt: Date.now() + settings.inspectionCacheMinutes * 60_000, value });
  return value;
}

export async function inspectLocalMedia(filePath: string, settings: SettingsRecord, archiveScanRoots = getArchiveScanRoots(settings)) {
  const candidate = resolve(expandPath(filePath));
  const allowed = [settings.dataDirectory, settings.downloadDirectory, ...archiveScanRoots, settings.temporaryDirectory];
  if (!allowed.some((root) => isPathWithin(candidate, root))) {
    throw new Error("Local inspection is limited to configured Archive Assistant directories.");
  }
  const stat = await fs.stat(candidate);
  if (!stat.isFile()) throw new Error("The selected local path is not a file.");
  const { ffprobe } = getLocalToolPaths(settings);
  const { stdout } = await execFileAsync(ffprobe, [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", candidate,
  ], { timeout: 20_000, maxBuffer: 10 * 1024 * 1024 });
  const probe = JSON.parse(stdout) as { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> };
  const streams = probe.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const subtitleStreams = streams.filter((stream) => stream.codec_type === "subtitle");
  const streamLanguage = (stream: Record<string, unknown>) => {
    const tags = stream.tags && typeof stream.tags === "object" ? stream.tags as Record<string, unknown> : {};
    return stringOrNull(tags.language);
  };
  const sideData = Array.isArray(video?.side_data_list)
    ? video.side_data_list
      .map((entry) => entry && typeof entry === "object" ? stringOrNull((entry as Record<string, unknown>).side_data_type) : null)
      .filter((value): value is string => Boolean(value))
      .join(", ")
    : null;
  const fpsValue = stringOrNull(video?.r_frame_rate);
  const [fpsN, fpsD] = fpsValue?.split("/").map(Number) ?? [];
  // The normalized quality model is derived from the same probe output, so the
  // scanner and the inspection endpoint never disagree about what a file is.
  const quality = technicalQualityFromProbe(probe, {
    reference: `probe:${candidate}`,
    label: basename(candidate),
    filename: basename(candidate),
    sizeBytes: stat.size,
    archiveRoot: archiveScanRoots.find((root) => isPathWithin(candidate, root)) ?? null,
  });
  return {
    filename: basename(candidate),
    path: candidate,
    extension: extname(candidate).replace(".", "").toLowerCase(),
    filesize: stat.size,
    durationSeconds: numberOrNull(probe.format?.duration),
    videoStreams: streams.filter((stream) => stream.codec_type === "video").length,
    audioStreams: audioStreams.length,
    subtitleStreams: subtitleStreams.length,
    width: numberOrNull(video?.width),
    height: numberOrNull(video?.height),
    fps: Number.isFinite(fpsN) && Number.isFinite(fpsD) && fpsD ? fpsN / fpsD : null,
    videoCodec: stringOrNull(video?.codec_name),
    audioCodec: stringOrNull(audio?.codec_name),
    audioChannels: numberOrNull(audio?.channels),
    audioLanguages: Array.from(new Set(audioStreams.map(streamLanguage).filter((value): value is string => Boolean(value)))),
    subtitleLanguages: Array.from(new Set(subtitleStreams.map(streamLanguage).filter((value): value is string => Boolean(value)))),
    bitrate: numberOrNull(probe.format?.bit_rate),
    container: stringOrNull(probe.format?.format_name),
    dynamicRange: stringOrNull(video?.color_transfer) ?? sideData,
    verification: "passed" as const,
    videoProfile: quality.videoProfile,
    videoPixFmt: quality.pixelFormat,
    videoBitDepth: quality.bitDepth,
    colorPrimaries: quality.colorPrimaries,
    dynamicRangeFormat: quality.dynamicRange,
    audioProfile: quality.audioProfile,
    audioChannelLayout: quality.audioChannelLayout,
    videoBitrate: quality.videoBitrate,
    audioBitrate: quality.audioBitrate,
    audioTracks: quality.audioTracks,
    subtitleTracks: quality.subtitleTracks,
  };
}

export function prepareDownload(input: {
  sourceUrl: string;
  title: string;
  sourceSite?: string | null;
  selectedFormatId: string;
  selectedVideoFormatId?: string | null;
  selectedAudioFormatId?: string | null;
  outputContainer?: string;
  temporaryDirectory?: string;
  destinationDirectory?: string;
  finalFilename?: string;
}, settings: SettingsRecord) {
  validateSourceUrl(input.sourceUrl);
  const outputContainer = input.outputContainer === "mkv" || input.outputContainer === "webm" ? input.outputContainer : settings.outputContainer;
  // The per-job temporary directory is optional in the API contract: a client
  // that does not name one downloads under the configured directory, which is
  // itself contained in that root by construction. An explicit client value is
  // still validated against the configured safe-directory roots, so omitting
  // never weakens path confinement.
  const requestedTemporaryDirectory = input.temporaryDirectory?.trim();
  const configuredTemporaryRoots = configuredDirectoryRoots(settings.temporaryDirectory);
  if (!requestedTemporaryDirectory && !configuredTemporaryRoots.length) {
    throw new Error("Temporary directory is required. Configure one in System Settings or pass it explicitly.");
  }
  const temporaryDirectory = validateSafeDirectory(
    requestedTemporaryDirectory || configuredTemporaryRoots[0],
    settings.temporaryDirectory,
    "Temporary directory",
  );
 const mediaType: ArchiveMediaType =
  /\bS\d{1,2}(?:E\d{1,2})?\b|\bSeason\s+\d+\b|\bEpisode\s+\d+\b|\bEp(?:isode)?\.?\s*\d+\b|\bSeries\s+\d+\b/i.test(input.title)
    ? "tv"
    : "movie";

const requestedDestination = input.destinationDirectory?.trim() || "";

const selectedVolume = requestedDestination
  ? findArchiveVolumeForPath(requestedDestination, settings)
  : chooseArchiveVolume(settings, mediaType);

if (!selectedVolume) {
  throw new Error(
    `No writable ${mediaType === "tv" ? "TV" : "movie"} archive volume is available.`,
  );
}

if (selectedVolume.mediaType !== mediaType) {
  throw new Error(
    `This media is classified as ${
      mediaType === "tv" ? "TV" : "a movie"
    } and cannot be written to ${selectedVolume.label}.`,
  );
}

ensureArchiveVolume(selectedVolume);

const destinationDirectory = requestedDestination
  ? validateSafeDirectory(
      requestedDestination,
      selectedVolume.path,
      "Destination directory",
    )
  : selectedVolume.path;
  const selectedFormatId = validateFormatId(input.selectedFormatId);
  const selectedVideoFormatId = input.selectedVideoFormatId ? validateFormatId(input.selectedVideoFormatId) : null;
  const selectedAudioFormatId = input.selectedAudioFormatId ? validateFormatId(input.selectedAudioFormatId) : null;
  const finalFilename = sanitizeFilename(input.finalFilename || input.title, outputContainer);
  return {
    sourceUrl: input.sourceUrl,
    title: input.title.trim() || "Untitled media",
    sourceSite: input.sourceSite?.trim() || new URL(input.sourceUrl).hostname,
    selectedFormatId,
    selectedVideoFormatId,
    selectedAudioFormatId,
    outputContainer,
    temporaryDirectory,
    destinationDirectory,
    finalFilename,
    validated: true,
  };
}