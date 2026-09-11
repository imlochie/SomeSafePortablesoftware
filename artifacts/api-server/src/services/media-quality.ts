/**
 * Normalized technical quality model and explainable encode comparison engine.
 *
 * This module is deliberately pure: it never touches the filesystem, never
 * shells out to FFprobe, and never writes to the database. It turns metadata
 * that the application already collects (FFprobe inspection results, scanned
 * file records, Plex media/part rows) into one normalized shape, then compares
 * two encodes of the same semantic media item with deterministic rules.
 *
 * Design rules that keep the intelligence explainable:
 *
 * 1. Only measured properties are ranked. Every ranked axis is a number or an
 *    explicit codec-class ordinal derived from stored metadata.
 * 2. A verdict of "superior" requires Pareto dominance: the winner must be at
 *    least as good on every comparable ranked axis and strictly better on at
 *    least one. "Higher resolution" alone never wins, and a bitrate advantage
 *    is ignored when the two files use different video codec generations,
 *    because a more efficient codec legitimately spends fewer bits.
 * 3. Axes that carry real information but no quality ordering (framerate,
 *    container, profile, audio language coverage, release provenance, file
 *    size, path/volume) are recorded as differences and reported, never ranked.
 * 4. Missing metadata produces `unknown`, never `worse`. Absence of evidence
 *    is reported as uncertainty instead of a verdict.
 * 5. Nothing in here proposes a deletion, a replacement, or a filesystem
 *    action. Results are findings for an operator to review.
 */

/** How the two encodes relate to each other. */
export type EncodeRelationship =
  | "exact_duplicate"
  | "probable_duplicate"
  | "equivalent"
  | "superior_encode"
  | "inferior_encode"
  | "materially_different_encode"
  | "different_media"
  | "insufficient_metadata";

/** How much trust the rules place in a verdict. */
export type QualityConfidence = "high" | "medium" | "low";

export type AxisStatus = "left_better" | "right_better" | "equal" | "different" | "unknown";

/**
 * `ranked`       - ordered by a measurement, participates in dominance.
 * `escalating`   - a real difference, never ordered, blocks "equivalent".
 * `informational`- recorded for the operator, no effect on the verdict.
 */
export type AxisMateriality = "ranked" | "escalating" | "informational";

export type QualityAxisName =
  | "resolution"
  | "dynamic_range"
  | "video_codec"
  | "video_profile"
  | "bit_depth"
  | "framerate"
  | "bitrate"
  | "video_bitrate"
  | "audio_codec"
  | "audio_channels"
  | "audio_bitrate"
  | "audio_languages"
  | "subtitle_languages"
  | "container"
  | "duration"
  | "file_size"
  | "checksum"
  | "source_provenance"
  | "location";

export type QualityAxisComparison = {
  axis: QualityAxisName;
  status: AxisStatus;
  materiality: AxisMateriality;
  leftValue: string | null;
  rightValue: string | null;
  /** Human-readable, deterministic explanation of this axis. */
  text: string;
  /** Extra caveat, only present when it changes how much to trust the axis. */
  note: string | null;
};

export type AudioTrackQuality = {
  index: number;
  codec: string | null;
  profile: string | null;
  channels: number | null;
  channelLayout: string | null;
  language: string | null;
  bitrate: number | null;
  default: boolean;
};

export type SubtitleTrackQuality = {
  index: number;
  codec: string | null;
  language: string | null;
  default: boolean;
  forced: boolean;
};

export type ReleaseProvenance =
  | "remux"
  | "disc_encode"
  | "web_dl"
  | "web_rip"
  | "tv_capture"
  | "camera_or_capture"
  | "unknown";

/**
 * The normalized quality record for one encode. Every field is nullable so a
 * partially inspected file still produces an honest, comparable model.
 */
export type TechnicalQuality = {
  /** What produced this model, so findings can point back at their source. */
  origin: "file_record" | "plex_media" | "probe";
  /** Stable pointer to the underlying row, e.g. `file_record:12`. */
  reference: string;
  /** Filename or Plex title, for display only. */
  label: string;
  identityKey: string | null;
  /** Semantic fingerprint already computed by the scanner. */
  fingerprint: string | null;

  container: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  checksum: string | null;
  checksumStatus: "computed" | "failed" | "not_computed" | null;

  width: number | null;
  height: number | null;
  /** `2160p`, `1080p`, `unknown`, or `audio only`. */
  resolution: string;
  pixels: number | null;
  aspectRatio: number | null;

  videoCodec: string | null;
  videoProfile: string | null;
  /** Coarse codec-generation ordinal, or null when unknown. */
  videoCodecClass: number | null;
  pixelFormat: string | null;
  bitDepth: number | null;
  chromaSubsampling: string | null;

  framerate: number | null;
  containerBitrate: number | null;
  videoBitrate: number | null;
  audioBitrate: number | null;
  /** Bits per pixel per frame; informational, never ranked. */
  bitsPerPixelFrame: number | null;

  dynamicRange: "sdr" | "hdr10" | "hdr10_plus" | "hlg" | "dolby_vision" | "unknown";
  colorTransfer: string | null;
  colorPrimaries: string | null;

  audioCodec: string | null;
  audioProfile: string | null;
  audioCodecClass: number | null;
  audioChannels: number | null;
  audioChannelLayout: string | null;
  audioTracks: AudioTrackQuality[];
  audioLanguages: string[];
  subtitleTracks: SubtitleTrackQuality[];
  subtitleLanguages: string[];

  provenance: ReleaseProvenance;
  releaseMarkers: string[];
  volumeId: string | null;
  archiveRoot: string | null;
  relativePath: string | null;
  /** `library` or `staging`, derived from where the record was scanned. */
  storageScope: "library" | "staging" | "plex" | "unknown";

  /** Number of ranked axes that are actually comparable for this record. */
  measuredAxes: number;
  /** True when no video or audio stream metadata survived inspection. */
  technicalMetadataMissing: boolean;
};

/** Row shape accepted from the archive scanner (a `file_record` row subset). */
export type FileRecordQualitySource = {
  id: number | string;
  filename: string;
  relative_path?: string | null;
  volume_id?: string | null;
  archive_root?: string | null;
  container?: string | null;
  duration_seconds?: number | null;
  size_bytes?: number | null;
  checksum?: string | null;
  checksum_status?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  video_codec?: string | null;
  video_profile?: string | null;
  video_pix_fmt?: string | null;
  video_bitrate?: number | null;
  bitrate?: number | null;
  dynamic_range?: string | null;
  color_primaries?: string | null;
  audio_codec?: string | null;
  audio_profile?: string | null;
  audio_channels?: number | null;
  audio_channel_layout?: string | null;
  audio_bitrate?: number | null;
  audio_tracks?: string | null;
  audio_languages?: string | null;
  subtitle_languages?: string | null;
  subtitle_tracks?: string | null;
  fingerprint?: string | null;
  scan_status?: string | null;
};

/** Plex media + part row subset (Plex reports bitrate in kbps). */
export type PlexMediaQualitySource = {
  id: number | string;
  ratingKey: string;
  label: string;
  identityKey?: string | null;
  videoResolution?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  /** Plex `Media.bitrate`, kilobits per second. */
  bitrateKbps?: number | null;
  durationMs?: number | null;
  container?: string | null;
  audioChannels?: number | null;
  audioChannelLayout?: string | null;
  dynamicRangeRaw?: string | null;
  part?: {
    filePath: string;
    sizeBytes: number | null;
    /** Plex reports a part hash that is not a documented file checksum. */
    hash: string | null;
  } | null;
};

/** FFprobe-shaped input; only the fields the scanner already requests. */
export type ProbeQualitySource = {
  format?: Record<string, unknown> | null;
  streams?: Array<Record<string, unknown>> | null;
};

const PLEX_BITRATE_KBPS_TO_BPS = 1000;
/** Resolution differences below this fraction are treated as equal (crops). */
const RESOLUTION_TOLERANCE = 0.02;
/** Duration differences above this are treated as a different cut. */
const DURATION_ABSOLUTE_TOLERANCE_SECONDS = 2;
const DURATION_RELATIVE_TOLERANCE = 0.01;
/** A higher-resolution side below this bits-per-pixel ratio is suspicious. */
const BITS_PER_PIXEL_INVERSION_RATIO = 0.45;

/**
 * Video codec generations, ordered by compression efficiency at equal bitrate.
 * This is a statement about the codec generation, not about a specific encode,
 * so it is only used to decide whether two bitrates are comparable at all.
 */
const VIDEO_CODEC_CLASS: Array<[RegExp, number]> = [
  [/\b(vvc|h\.?266)\b/i, 5],
  [/\b(av1|av01)\b/i, 4],
  [/\b(hevc|h\.?265|hvc1|hev1)\b/i, 3],
  [/\b(vp9|vp09)\b/i, 3],
  [/\b(avc|h\.?264|x264|vavc|avc1)\b/i, 2],
  [/\b(mpeg4|mp4v|xvid|divx)\b/i, 1],
  [/\b(mpeg2video|mpv2)\b/i, 0],
];

/**
 * Audio codec generations, ordered by fidelity class. Lossless and
 * losslessly-compressed formats outrank lossy ones; the ordinal never claims
 * that one lossy codec is perceptually better than another.
 */
const AUDIO_CODEC_CLASS: Array<[RegExp, number]> = [
  [/\b(truehd|mlp|dts[- ]?hd|dtshd|flac|alac|pcm)/i, 5],
  [/\b(eac3|ac4|dts|dca)/i, 4],
  [/\b(ac3|aac|mp4a|opus|vorbis)/i, 3],
  [/\b(mp2|mp3|mp3float)\b/i, 2],
];

const PROVENANCE_PATTERNS: Array<[RegExp, ReleaseProvenance]> = [
  [/\bremux\b/i, "remux"],
  [/\b(uhd[ ._-]?bluray|bluray|bd[- ]?rip|bdremux|bd50|bd25|hddvd|disc)\b/i, "disc_encode"],
  [/\bweb[ ._-]?dl\b/i, "web_dl"],
  [/\b(web[ ._-]?rip|webrip|web[ ._-]?dl[ ._-]?rip|itunes|amazon|nf|amzn|dsny|atvp|hmax|hulu)\b/i, "web_rip"],
  [/\b(hdtv|dvb|pdtv|dsr|sdtv|vhsrrip|dvd[- ]?rip|dvd)\b/i, "tv_capture"],
  [/\b(cam|camrip|telesync|ts\b|screener|scr)\b/i, "camera_or_capture"],
];

const RELEASE_MARKER_PATTERN =
  /\b(remux|uhd|bluray|bdrip|bdremux|web[- ]?dl|web[- ]?rip|webrip|hdtv|dvdrip|x264|x265|h\.?264|h\.?265|hevc|av1|vp9|hdr10\+?|hdr|dolby[- ]?vision|dv10|10[- ]?bit|8[- ]?bit|atmos|dts[- ]?hd|truehd|aac|ac3|eac3|opus|flac|ngu|smol)\b/gi;

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["1", "true", "yes"].includes(value.trim().toLowerCase());
  return false;
}

/** Parses the JSON string columns stored on `file_record`. */
function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function parseTrackArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function ordinalFor(patterns: Array<[RegExp, number]>, codec: string | null): number | null {
  if (!codec) return null;
  for (const [pattern, value] of patterns) {
    if (pattern.test(codec)) return value;
  }
  return null;
}

function isHdrToken(value: string | null): boolean {
  return Boolean(value && /hdr|smpte2084|arib-std-b67|hlg|dolby[- ]?vision|dovi/i.test(value));
}

/** Classifies the dynamic range from the metadata the scanner already stores. */
export function classifyDynamicRange(input: {
  colorTransfer?: string | null;
  colorPrimaries?: string | null;
  sideData?: string | null;
  metadataEncoding?: string | null;
  raw?: string | null;
}): { dynamicRange: TechnicalQuality["dynamicRange"]; hdr: boolean } {
  const haystack = [
    input.raw,
    input.colorTransfer,
    input.colorPrimaries,
    input.sideData,
    input.metadataEncoding,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
  if (!haystack) return { dynamicRange: "unknown", hdr: false };
  // Order matters: Dolby Vision and HDR10+ carry dynamic metadata, so they are
  // reported separately from static-metadata HDR10.
  if (/dolby[- ]?vision|dovi/i.test(haystack)) return { dynamicRange: "dolby_vision", hdr: true };
  if (/hdr10\+|hdr10plus|smpte2094|st ?2084.*metadata/i.test(haystack)) return { dynamicRange: "hdr10_plus", hdr: true };
  if (/arib-std-b67|\bhlg\b/i.test(haystack)) return { dynamicRange: "hlg", hdr: true };
  if (/smpte2084|hdr10|\bhdr\b|pq/i.test(haystack)) return { dynamicRange: "hdr10", hdr: true };
  if (/bt\.?709|bt\.?2020|smpte170m|iec61966/i.test(haystack)) return { dynamicRange: "sdr", hdr: false };
  return { dynamicRange: "unknown", hdr: false };
}

/** Derives bit depth and chroma from the FFmpeg pixel format string. */
export function parsePixelFormat(pixFmt: string | null): { bitDepth: number | null; chroma: string | null } {
  if (!pixFmt) return { bitDepth: null, chroma: null };
  const value = pixFmt.trim().toLowerCase();
  let bitDepth: number | null = null;
  let chroma: string | null = null;
  // Planar FFmpeg formats: yuv420p, yuv420p10le, yuv444p, yuva444p16be...
  const planar = /^yuva?(?:jg)?(4\d{2})p?(?:(\d{1,2})(?:le|be))?$/.exec(value);
  if (planar) {
    chroma = planar[1];
    // A planar `yuvXXXp` with no explicit depth is 8-bit by definition.
    bitDepth = planar[2] ? Number(planar[2]) : 8;
  } else if (/^gbrp?(\d{1,2})?(le|be)?$/.test(value)) {
    chroma = "444";
    bitDepth = Number(/^gbrp?(\d{1,2})/.exec(value)?.[1] ?? 8);
  } else if (/^gray(\d{1,2})?(le|be)?$/.test(value)) {
    chroma = "400";
    bitDepth = Number(/^gray(\d{1,2})/.exec(value)?.[1] ?? 8);
  } else if (/^p01\d$/.test(value)) {
    chroma = "420";
    bitDepth = Number(/^p0(\d{2})$/.exec(value)?.[1]);
  } else if (/^nv[12]\d$/.test(value)) {
    chroma = "420";
    bitDepth = 8;
  }
  if (bitDepth !== null && (!Number.isFinite(bitDepth) || bitDepth < 8 || bitDepth > 16)) bitDepth = null;
  return { bitDepth, chroma };
}

/**
 * Classifies release provenance from filename markers. Provenance describes
 * where an encode came from; it is never used to declare a better encode.
 */
export function classifyProvenance(value: string | null | undefined): ReleaseProvenance {
  if (!value) return "unknown";
  for (const [pattern, provenance] of PROVENANCE_PATTERNS) {
    if (pattern.test(value)) return provenance;
  }
  return "unknown";
}

export function releaseMarkers(value: string | null | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const ordered: Array<{ marker: string; at: number }> = [];
  for (const match of value.matchAll(RELEASE_MARKER_PATTERN)) {
    const marker = match[0].trim().toLowerCase().replace(/[\s.]+/g, "-");
    if (!marker || seen.has(marker)) continue;
    seen.add(marker);
    ordered.push({ marker, at: match.index ?? 0 });
  }
  // Ordered by where they appear in the release name, so the list reads like
  // the filename, and deterministically for identical inputs.
  return ordered.sort((left, right) => left.at - right.at).map((entry) => entry.marker);
}

function resolutionLabel(height: number | null, hasVideo: boolean): string {
  if (!hasVideo) return height === null ? "unknown" : `${height}p`;
  return height ? `${height}p` : "unknown";
}

function storageScopeFor(root: string | null | undefined, volumeId: string | null | undefined): TechnicalQuality["storageScope"] {
  const haystack = `${root ?? ""} ${volumeId ?? ""}`;
  if (!haystack.trim()) return "unknown";
  return /download|staging|temp|incoming/i.test(haystack) ? "staging" : "library";
}

function fractionOrNull(value: string | null): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split("/").map((part) => Number(part.trim()));
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function deriveQuality(input: {
  origin: TechnicalQuality["origin"];
  reference: string;
  label: string;
  identityKey: string | null;
  fingerprint: string | null;
  container: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  checksum: string | null;
  checksumStatus: TechnicalQuality["checksumStatus"];
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  videoProfile: string | null;
  pixelFormat: string | null;
  framerate: number | null;
  containerBitrate: number | null;
  videoBitrate: number | null;
  audioBitrate: number | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  sideData: string | null;
  audioCodec: string | null;
  audioProfile: string | null;
  audioChannels: number | null;
  audioChannelLayout: string | null;
  audioTracks: AudioTrackQuality[];
  audioLanguages: string[];
  subtitleTracks: SubtitleTrackQuality[];
  subtitleLanguages: string[];
  volumeId: string | null;
  archiveRoot: string | null;
  relativePath: string | null;
  storageScope: TechnicalQuality["storageScope"];
  provenanceSource: string | null;
}): TechnicalQuality {
  const hasVideo = input.width !== null || input.height !== null || Boolean(input.videoCodec);
  const hasAudio = input.audioTracks.length > 0 || Boolean(input.audioCodec) || input.audioChannels !== null;
  const { dynamicRange, hdr } = classifyDynamicRange({
    colorTransfer: input.colorTransfer,
    colorPrimaries: input.colorPrimaries,
    sideData: input.sideData,
  });
  const { bitDepth, chroma } = parsePixelFormat(input.pixelFormat);
  const width = input.width;
  const height = input.height;
  const pixels = width !== null && height !== null && width > 0 && height > 0 ? width * height : null;
  const frameCount = input.framerate && input.durationSeconds ? input.framerate * input.durationSeconds : null;
  const bitrateForVideo = input.videoBitrate ?? input.containerBitrate ?? null;
  const bitsPerPixelFrame = pixels && frameCount && bitrateForVideo
    ? (bitrateForVideo * (input.durationSeconds ?? 0)) / (pixels * frameCount)
    : null;
  const videoChannelsFromTracks = input.audioTracks.reduce(
    (best, track) => (track.channels !== null && track.channels > best ? track.channels : best),
    -1,
  );
  const audioChannels = input.audioChannels ?? (videoChannelsFromTracks >= 0 ? videoChannelsFromTracks : null);
  const measuredAxes = [
    pixels,
    hasVideo ? (hdr ? 1 : 0) : null,
    ordinalFor(VIDEO_CODEC_CLASS, input.videoCodec),
    bitDepth,
    bitrateForVideo,
    ordinalFor(AUDIO_CODEC_CLASS, input.audioCodec),
    audioChannels,
    input.audioBitrate,
    input.framerate,
  ].filter((value) => value !== null && value !== undefined).length;

  return {
    origin: input.origin,
    reference: input.reference,
    label: input.label,
    identityKey: input.identityKey,
    fingerprint: input.fingerprint,
    container: input.container,
    durationSeconds: input.durationSeconds,
    sizeBytes: input.sizeBytes,
    checksum: input.checksum,
    checksumStatus: input.checksumStatus,
    width,
    height,
    resolution: resolutionLabel(height, hasVideo),
    pixels,
    aspectRatio: width && height ? Math.round((width / height) * 1000) / 1000 : null,
    videoCodec: input.videoCodec,
    videoProfile: input.videoProfile,
    videoCodecClass: ordinalFor(VIDEO_CODEC_CLASS, input.videoCodec),
    pixelFormat: input.pixelFormat,
    bitDepth,
    chromaSubsampling: chroma,
    framerate: input.framerate === null ? null : Math.round(input.framerate * 1000) / 1000,
    containerBitrate: input.containerBitrate,
    videoBitrate: input.videoBitrate,
    audioBitrate: input.audioBitrate,
    bitsPerPixelFrame: bitsPerPixelFrame === null ? null : Math.round(bitsPerPixelFrame * 10000) / 10000,
    dynamicRange,
    colorTransfer: input.colorTransfer,
    colorPrimaries: input.colorPrimaries,
    audioCodec: input.audioCodec,
    audioProfile: input.audioProfile,
    audioCodecClass: ordinalFor(AUDIO_CODEC_CLASS, input.audioCodec),
    audioChannels,
    audioChannelLayout: input.audioChannelLayout,
    audioTracks: input.audioTracks,
    audioLanguages: input.audioLanguages,
    subtitleTracks: input.subtitleTracks,
    subtitleLanguages: input.subtitleLanguages,
    provenance: classifyProvenance(input.provenanceSource),
    releaseMarkers: releaseMarkers(input.provenanceSource),
    volumeId: input.volumeId,
    archiveRoot: input.archiveRoot,
    relativePath: input.relativePath,
    storageScope: input.storageScope,
    measuredAxes,
    technicalMetadataMissing: !hasVideo && !hasAudio,
  };
}

/** Builds the model from an FFprobe-shaped probe (the single parsing point). */
export function technicalQualityFromProbe(
  probe: ProbeQualitySource,
  meta: {
    reference: string;
    label: string;
    filename?: string | null;
    identityKey?: string | null;
    fingerprint?: string | null;
    sizeBytes?: number | null;
    checksum?: string | null;
    checksumStatus?: TechnicalQuality["checksumStatus"];
    volumeId?: string | null;
    archiveRoot?: string | null;
    relativePath?: string | null;
  },
): TechnicalQuality {
  const format = probe.format && typeof probe.format === "object" ? (probe.format as Record<string, unknown>) : {};
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStreams = streams.filter((stream) => text(stream.codec_type) === "video");
  const audioStreams = streams.filter((stream) => text(stream.codec_type) === "audio");
  const subtitleStreams = streams.filter((stream) => text(stream.codec_type) === "subtitle");
  const video = videoStreams[0] ?? null;
  // Default audio track first, mirroring how players pick a stream.
  const audio =
    audioStreams.find((stream) => boolValue(asRecord(stream.disposition).default)) ?? audioStreams[0] ?? null;
  const streamTags = (stream: Record<string, unknown> | null) => asRecord(stream?.tags);
  const sideData = video && Array.isArray(video.side_data_list)
    ? (video.side_data_list as unknown[])
        .map((entry) => text(asRecord(entry).side_data_type))
        .filter((value): value is string => Boolean(value))
        .join(", ")
    : null;
  const audioTracks: AudioTrackQuality[] = audioStreams.map((stream, index) => ({
    index,
    codec: text(stream.codec_name),
    profile: text(stream.profile),
    channels: numberValue(stream.channels),
    channelLayout: text(stream.channel_layout),
    language: text(streamTags(stream).language),
    bitrate: numberValue(stream.bit_rate),
    default: boolValue(asRecord(stream.disposition).default) || (index === 0 && audioStreams.length === 1),
  }));
  const subtitleTracks: SubtitleTrackQuality[] = subtitleStreams.map((stream, index) => ({
    index,
    codec: text(stream.codec_name),
    language: text(streamTags(stream).language),
    default: boolValue(asRecord(stream.disposition).default),
    forced: boolValue(asRecord(stream.disposition).forced),
  }));
  const uniqueLanguages = (values: Array<string | null>) =>
    Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort(
      (left, right) => left.localeCompare(right),
    );

  const height = numberValue(video?.height);
  const width = numberValue(video?.width);
  const containerBitrate = numberValue(format.bit_rate);
  const perStreamVideoBitrate = videoStreams.reduce<number>((best, stream) => {
    const value = numberValue(stream.bit_rate);
    return value !== null && value > best ? value : best;
  }, -1);

  return deriveQuality({
    origin: "probe",
    reference: meta.reference,
    label: meta.label,
    identityKey: meta.identityKey ?? null,
    fingerprint: meta.fingerprint ?? null,
    container: text(format.format_name),
    durationSeconds: numberValue(format.duration),
    sizeBytes: numberValue(format.size) ?? meta.sizeBytes ?? null,
    checksum: meta.checksum ?? null,
    checksumStatus: meta.checksumStatus ?? null,
    width,
    height,
    videoCodec: text(video?.codec_name),
    videoProfile: text(video?.profile),
    pixelFormat: text(video?.pix_fmt),
    framerate: fractionOrNull(text(video?.r_frame_rate) ?? null),
    containerBitrate,
    videoBitrate: perStreamVideoBitrate >= 0 ? perStreamVideoBitrate : null,
    audioBitrate: audio ? numberValue(audio.bit_rate) : null,
    colorTransfer: text(video?.color_transfer),
    colorPrimaries: text(video?.color_primaries),
    sideData,
    audioCodec: text(audio?.codec_name),
    audioProfile: text(audio?.profile),
    audioChannels: audio ? numberValue(audio.channels) : null,
    audioChannelLayout: audio ? text(audio.channel_layout) : null,
    audioTracks,
    audioLanguages: uniqueLanguages(audioTracks.map((track) => track.language)),
    subtitleTracks,
    subtitleLanguages: uniqueLanguages(subtitleTracks.map((track) => track.language)),
    volumeId: meta.volumeId ?? null,
    archiveRoot: meta.archiveRoot ?? null,
    relativePath: meta.relativePath ?? null,
    storageScope: storageScopeFor(meta.archiveRoot, meta.volumeId),
    provenanceSource: meta.filename ?? meta.label,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Rebuilds the model from a stored `file_record` row. */
export function technicalQualityFromRecord(row: FileRecordQualitySource): TechnicalQuality {
  const audioTracks = parseTrackArray<AudioTrackQuality>(row.audio_tracks);
  const subtitleTracks = parseTrackArray<SubtitleTrackQuality>(row.subtitle_tracks);
  const storedChecksumStatus = text(row.checksum_status);
  const checksum = text(row.checksum);
  const checksumStatus: TechnicalQuality["checksumStatus"] = checksum
    ? "computed"
    : storedChecksumStatus === "failed"
      ? "failed"
      : storedChecksumStatus === "not_computed" || storedChecksumStatus === null
        ? "not_computed"
        : null;
  const colorTransfer = text(row.dynamic_range);
  const height = row.height ?? null;
  const width = row.width ?? null;

  return deriveQuality({
    origin: "file_record",
    reference: `file_record:${row.id}`,
    label: row.filename,
    identityKey: null,
    fingerprint: text(row.fingerprint),
    container: text(row.container),
    durationSeconds: numberValue(row.duration_seconds),
    sizeBytes: numberValue(row.size_bytes),
    checksum,
    checksumStatus,
    width,
    height,
    videoCodec: text(row.video_codec),
    videoProfile: text(row.video_profile),
    pixelFormat: text(row.video_pix_fmt),
    framerate: numberValue(row.fps),
    containerBitrate: numberValue(row.bitrate),
    videoBitrate: numberValue(row.video_bitrate),
    audioBitrate: numberValue(row.audio_bitrate),
    colorTransfer,
    colorPrimaries: text(row.color_primaries),
    // The scanner folds FFprobe side-data into `dynamic_range` when no
    // color_transfer is present, so a non-transfer string is treated as notes.
    sideData: colorTransfer && !/bt\.?709|bt\.?2020|smpte170m/i.test(colorTransfer) ? colorTransfer : null,
    audioCodec: text(row.audio_codec),
    audioProfile: text(row.audio_profile),
    audioChannels: numberValue(row.audio_channels),
    audioChannelLayout: text(row.audio_channel_layout),
    audioTracks: audioTracks.length
      ? audioTracks
      : text(row.audio_codec)
        ? [{
            index: 0,
            codec: text(row.audio_codec),
            profile: text(row.audio_profile),
            channels: numberValue(row.audio_channels),
            channelLayout: text(row.audio_channel_layout),
            language: parseStringArray(row.audio_languages)[0] ?? null,
            bitrate: numberValue(row.audio_bitrate),
            default: true,
          }]
        : [],
    audioLanguages: parseStringArray(row.audio_languages),
    subtitleTracks,
    subtitleLanguages: parseStringArray(row.subtitle_languages),
    volumeId: text(row.volume_id),
    archiveRoot: text(row.archive_root),
    relativePath: text(row.relative_path),
    storageScope: storageScopeFor(text(row.archive_root), text(row.volume_id)),
    provenanceSource: row.filename,
  });
}

/** Rebuilds the model from cached Plex media/part metadata. */
export function technicalQualityFromPlexMedia(row: PlexMediaQualitySource): TechnicalQuality {
  const height = row.videoResolution ? Number.parseInt(row.videoResolution.replace(/\D/g, ""), 10) || null : null;
  const dynamicRange = classifyDynamicRange({ raw: row.dynamicRangeRaw });
  const channels = row.audioChannels ?? null;
  const audioTracks: AudioTrackQuality[] = row.audioCodec
    ? [{
        index: 0,
        codec: row.audioCodec,
        profile: null,
        channels,
        channelLayout: row.audioChannelLayout ?? null,
        language: null,
        bitrate: null,
        default: true,
      }]
    : [];

  return deriveQuality({
    origin: "plex_media",
    reference: `plex_media:${row.id}`,
    label: row.label,
    identityKey: row.identityKey ?? null,
    fingerprint: null,
    container: row.container ?? null,
    durationSeconds: row.durationMs !== null && row.durationMs !== undefined ? row.durationMs / 1000 : null,
    sizeBytes: row.part?.sizeBytes ?? null,
    // Plex exposes a part hash, not a documented file checksum, so it is not
    // treated as byte-identity evidence.
    checksum: null,
    checksumStatus: row.part?.hash ? "not_computed" : null,
    width: null,
    height,
    videoCodec: row.videoCodec ?? null,
    videoProfile: null,
    pixelFormat: null,
    framerate: null,
    // Plex reports container bitrate in kbps; normalize to bps for comparison.
    containerBitrate:
      row.bitrateKbps !== null && row.bitrateKbps !== undefined
        ? row.bitrateKbps * PLEX_BITRATE_KBPS_TO_BPS
        : null,
    videoBitrate: null,
    audioBitrate: null,
    colorTransfer: null,
    colorPrimaries: null,
    sideData: dynamicRange.hdr ? row.dynamicRangeRaw ?? null : null,
    audioCodec: row.audioCodec ?? null,
    audioProfile: null,
    audioChannels: channels,
    audioChannelLayout: row.audioChannelLayout ?? null,
    audioTracks,
    audioLanguages: [],
    subtitleTracks: [],
    subtitleLanguages: [],
    volumeId: "plex",
    archiveRoot: null,
    relativePath: row.part?.filePath ?? null,
    storageScope: "plex",
    provenanceSource: row.part?.filePath ?? row.label,
  });
}

/**
 * Rebuilds the model from a cached `plex_item` row plus its first `plex_media`
 * entry. Plex keeps per-stream detail inside `metadata_json`, which is where
 * audio layout, languages, and HDR flags actually live; reading them here keeps
 * Plex comparisons on the same normalized model as local files.
 */
export function technicalQualityFromPlexItemRow(row: {
  id: number | string;
  ratingKey: string;
  title: string;
  metadataJson: string;
  videoResolution?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  bitrateKbps?: number | null;
  identityKey?: string | null;
}): TechnicalQuality {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metadataJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  const mediaList = Array.isArray(metadata.Media) ? metadata.Media : [];
  const media = asRecord(mediaList[0]);
  const parts = Array.isArray(media.Part) ? media.Part : [];
  const part = asRecord(parts[0]);
  const partStreams = Array.isArray(part.Stream) ? part.Stream : [];
  const audioStreams = partStreams
    .map(asRecord)
    .filter((stream) => text(stream.codecType)?.toLowerCase() === "audio" || stream.audioChannelLayout !== undefined);
  const primaryAudio = audioStreams[0] ?? null;
  const languages = (kind: string) =>
    Array.from(
      new Set(
        partStreams
          .map(asRecord)
          .filter((stream) => text(stream.codecType)?.toLowerCase() === kind)
          .map((stream) => text(stream.languageCode) ?? text(stream.language))
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort((left, right) => left.localeCompare(right));

  const quality = technicalQualityFromPlexMedia({
    id: row.id,
    ratingKey: row.ratingKey,
    label: row.title,
    identityKey: row.identityKey ?? null,
    videoResolution: row.videoResolution ?? (text(media.videoResolution) ?? undefined) ?? null,
    videoCodec: row.videoCodec ?? (text(media.videoCodec) ?? undefined) ?? null,
    audioCodec: row.audioCodec ?? (text(media.audioCodec) ?? undefined) ?? null,
    bitrateKbps: row.bitrateKbps ?? null,
    durationMs: numberValue(media.duration) ?? null,
    container: text(media.container) ?? text(part.container) ?? null,
    audioChannels: numberValue(primaryAudio?.channels) ?? numberValue(media.audioChannels) ?? null,
    audioChannelLayout: text(primaryAudio?.audioChannelLayout) ?? null,
    dynamicRangeRaw: [
      text(media["videoRange"]),
      text(media["@videoRange"]),
      boolValue(media["HDR"]) || boolValue(media["@HDR"]) ? "hdr10" : null,
    ].find(Boolean) ?? null,
    part: part.file
      ? {
          filePath: String(part.file),
          sizeBytes: numberValue(part.size) ?? null,
          hash: text(part.hash),
        }
      : null,
  });
  // The inventory row is a Plex *item* joined to its first media entry, so the
  // pointer identifies the item rather than the media id.
  return { ...quality, reference: `plex_item:${row.id}` };
}

/**
 * Coarse ordering kept for the legacy `best_local_version` status. It is only
 * used as a fallback when Pareto dominance is inconclusive, and its weights
 * are intentionally conservative.
 */
export function coarseQualityScore(quality: TechnicalQuality): number {
  const height = quality.height ?? 0;
  const hdr = quality.dynamicRange !== "sdr" && quality.dynamicRange !== "unknown" ? 5000 : 0;
  const codec = /av1/i.test(quality.videoCodec ?? "")
    ? 300
    : /265|hevc/i.test(quality.videoCodec ?? "")
      ? 250
      : /264/i.test(quality.videoCodec ?? "")
        ? 150
        : 50;
  const bitrate = Math.min(100, Math.round((quality.containerBitrate ?? 0) / 1_000_000));
  const audio = quality.audioChannels ?? 0;
  return height + hdr + codec + bitrate + audio;
}

function describeFramerate(value: number | null): string {
  return value === null ? "unknown" : String(Math.round(value * 1000) / 1000);
}

function describeBitrate(value: number | null): string {
  return value === null ? "unknown" : `${Math.round(value / 1000)} kbps`;
}

function describeLanguages(values: string[]): string {
  return values.length ? values.join(",") : "untagged";
}

type AxisDraft = Omit<QualityAxisComparison, "text" | "note"> & { text?: string; note?: string };

function finalizeAxis(axis: AxisDraft): QualityAxisComparison {
  const left = axis.leftValue ?? "unknown";
  const right = axis.rightValue ?? "unknown";
  const label = axis.axis.replaceAll("_", " ");
  if (axis.status === "equal") {
    return { ...axis, text: `${label}: both ${left}`, note: axis.note ?? null };
  }
  if (axis.status === "unknown") {
    return {
      ...axis,
      text: `${label}: ${left === "unknown" && right === "unknown" ? "not available on either side" : `${left} vs ${right} (one side unavailable)`}`,
      note: axis.note ?? null,
    };
  }
  return { ...axis, text: `${label}: ${left} vs ${right}`, note: axis.note ?? null };
}

function compareNumbers(
  axis: QualityAxisName,
  materiality: AxisMateriality,
  left: number | null,
  right: number | null,
  format: (value: number | null) => string,
  options: { higherIsBetter?: boolean; tolerance?: number; note?: string } = {},
): AxisDraft | null {
  if (left === null && right === null) return null;
  if (left === null || right === null) {
    return {
      axis,
      materiality,
      status: "unknown",
      leftValue: format(left),
      rightValue: format(right),
      note: options.note,
    };
  }
  const higherIsBetter = options.higherIsBetter ?? true;
  const difference = left - right;
  const magnitude = Math.max(Math.abs(left), Math.abs(right));
  const tolerance = options.tolerance ?? 0;
  if (Math.abs(difference) <= (tolerance > 1 ? tolerance : tolerance * Math.max(magnitude, 1))) {
    return {
      axis,
      materiality,
      status: "equal",
      leftValue: format(left),
      rightValue: format(right),
      note: options.note,
    };
  }
  const leftBetter = higherIsBetter ? difference > 0 : difference < 0;
  return {
    axis,
    materiality,
    status: leftBetter ? "left_better" : "right_better",
    leftValue: format(left),
    rightValue: format(right),
    note: options.note,
  };
}

function compareOrdinal(
  axis: QualityAxisName,
  materiality: AxisMateriality,
  left: number | null,
  right: number | null,
  format: (value: number | null) => string,
  note?: string,
): AxisDraft | null {
  if (left === null && right === null) return null;
  if (left === null || right === null) {
    return { axis, materiality, status: "unknown", leftValue: format(left), rightValue: format(right), note };
  }
  if (left === right) {
    return { axis, materiality, status: "equal", leftValue: format(left), rightValue: format(right), note };
  }
  return {
    axis,
    materiality,
    status: left > right ? "left_better" : "right_better",
    leftValue: format(left),
    rightValue: format(right),
    note,
  };
}

function compareStrings(
  axis: QualityAxisName,
  materiality: AxisMateriality,
  left: string | null,
  right: string | null,
  note?: string,
): AxisDraft | null {
  const leftValue = left ?? null;
  const rightValue = right ?? null;
  if (leftValue === null && rightValue === null) return null;
  if (leftValue === rightValue) {
    return { axis, materiality, status: "equal", leftValue: leftValue ?? "unknown", rightValue: rightValue ?? "unknown", note };
  }
  if (leftValue === null || rightValue === null) {
    return { axis, materiality, status: "unknown", leftValue: leftValue ?? "unknown", rightValue: rightValue ?? "unknown", note };
  }
  return { axis, materiality, status: "different", leftValue, rightValue, note };
}

function compareSets(
  axis: QualityAxisName,
  materiality: AxisMateriality,
  left: string[],
  right: string[],
  note?: string,
): AxisDraft | null {
  const leftValue = describeLanguages(left);
  const rightValue = describeLanguages(right);
  if (leftValue === rightValue) {
    return left.length
      ? { axis, materiality, status: "equal", leftValue, rightValue, note }
      : null;
  }
  if (leftValue === "untagged" || rightValue === "untagged") {
    return { axis, materiality, status: "unknown", leftValue, rightValue, note };
  }
  return { axis, materiality, status: "different", leftValue, rightValue, note };
}

export type QualityComparison = {
  relationship: EncodeRelationship;
  /** Which side is preferred, or null when the evidence does not support one. */
  winner: "left" | "right" | null;
  winnerReference: string | null;
  confidence: QualityConfidence | null;
  /** Verdict sentences, ordered from strongest evidence to weakest. */
  reasons: string[];
  /** What an operator must know before trusting the verdict. */
  uncertainty: string[];
  axes: QualityAxisComparison[];
  /** Axis texts formatted the way the existing archive inventory reports them. */
  differenceSummary: string[];
  left: TechnicalQuality;
  right: TechnicalQuality;
  /** True when both encodes carry the same byte-level content. */
  identical: boolean;
  /** Ranked axes where the two encodes actually differ. */
  rankedDifferences: number;
};

/**
 * Compares two encodes of the same semantic media item.
 *
 * Callers are responsible for only comparing items they believe describe the
 * same media; the engine still guards against it via the duration and identity
 * checks below and degrades to `different_media` instead of guessing.
 */
export function compareEncodes(
  left: TechnicalQuality,
  right: TechnicalQuality,
  options: { sameSemanticItem?: boolean } = {},
): QualityComparison {
  const reasons: string[] = [];
  const uncertainty: string[] = [];
  const axes: AxisDraft[] = [];

  // --- Byte-level evidence first: it is the only deterministic identity. ---
  const leftChecksum = left.checksum?.toLowerCase() ?? null;
  const rightChecksum = right.checksum?.toLowerCase() ?? null;
  const checksumsMatch = Boolean(leftChecksum && rightChecksum && leftChecksum === rightChecksum);
  const checksumsDiffer = Boolean(leftChecksum && rightChecksum && leftChecksum !== rightChecksum);
  if (leftChecksum && rightChecksum) {
    axes.push({
      axis: "checksum",
      materiality: checksumsMatch ? "informational" : "escalating",
      status: checksumsMatch ? "equal" : "different",
      leftValue: `${leftChecksum.slice(0, 12)}…`,
      rightValue: `${rightChecksum.slice(0, 12)}…`,
      note: checksumsMatch
        ? "SHA-256 equality is byte-level proof; every other difference is container-level or metadata noise."
        : "Different checksums prove the files are not byte-identical; they do not say which is better.",
    });
  } else {
    uncertainty.push(
      `No SHA-256 on ${!leftChecksum && !rightChecksum ? "either side" : leftChecksum ? "the Plex/other side" : "the local side"}, so byte-identity cannot be excluded or confirmed.`,
    );
  }

  if (checksumsMatch) {
    // Byte-identical content: everything else is presentation of the same bits.
    const conflictingAxes: string[] = [];
    if (left.sizeBytes !== null && right.sizeBytes !== null && left.sizeBytes !== right.sizeBytes) {
      conflictingAxes.push(`file size ${left.sizeBytes} vs ${right.sizeBytes} bytes`);
    }
    if (left.height !== null && right.height !== null && left.height !== right.height) {
      conflictingAxes.push(`height ${left.height} vs ${right.height}`);
    }
    if (left.videoCodec && right.videoCodec && left.videoCodec !== right.videoCodec) {
      conflictingAxes.push(`video codec ${left.videoCodec} vs ${right.videoCodec}`);
    }
    if (left.audioCodec && right.audioCodec && left.audioCodec !== right.audioCodec) {
      conflictingAxes.push(`audio codec ${left.audioCodec} vs ${right.audioCodec}`);
    }
    if (conflictingAxes.length) {
      uncertainty.push(
        `Byte-identical files carry conflicting technical metadata (${conflictingAxes.join(", ")}); the metadata, not the media, needs correction.`,
      );
    }
    reasons.push("Exact duplicate: both records share the same SHA-256 checksum.");
  }

  // --- Size and duration agreement. ---
  if (left.sizeBytes !== null && right.sizeBytes !== null) {
    const sizeRatio = Math.abs(left.sizeBytes - right.sizeBytes) / Math.max(left.sizeBytes, right.sizeBytes, 1);
    axes.push({
      axis: "file_size",
      materiality: "informational",
      status: sizeRatio === 0 ? "equal" : sizeRatio <= 0.001 ? "equal" : "different",
      leftValue: `${left.sizeBytes} bytes`,
      rightValue: `${right.sizeBytes} bytes`,
      note: sizeRatio > 0.01 ? `File size differs by ${(sizeRatio * 100).toFixed(1)}%; size follows encode choices, it is not a quality measure.` : undefined,
    });
  }

  const duration = compareNumbers(
    "duration",
    "escalating",
    left.durationSeconds,
    right.durationSeconds,
    (value) => (value === null ? "unknown" : `${Math.round(value * 100) / 100}s`),
    { higherIsBetter: true, tolerance: 0 },
  );
  let differentCut = false;
  if (left.durationSeconds !== null && right.durationSeconds !== null) {
    const delta = Math.abs(left.durationSeconds - right.durationSeconds);
    const tolerance = Math.max(
      DURATION_ABSOLUTE_TOLERANCE_SECONDS,
      Math.max(left.durationSeconds, right.durationSeconds) * DURATION_RELATIVE_TOLERANCE,
    );
    differentCut = delta > tolerance;
    if (differentCut && duration) {
      duration.status = "different";
      duration.note = `Runtimes differ by ${Math.round(delta)}s, which usually means a different cut, edition, or extra scenes rather than a re-encode.`;
    } else if (duration) {
      duration.status = "equal";
      duration.note = undefined;
    }
  }
  if (duration) axes.push(duration);

  if (differentCut && !checksumsMatch) {
    axes.push(
      compareStrings("source_provenance", "escalating", left.provenance, right.provenance) ?? {
        axis: "source_provenance",
        materiality: "escalating",
        status: "unknown",
        leftValue: left.provenance,
        rightValue: right.provenance,
      },
    );
    return {
      relationship: "different_media",
      winner: null,
      winnerReference: null,
      confidence: null,
      reasons: [
        `No quality verdict: the two records differ by more than the runtime tolerance (${Math.round(
          Math.abs((left.durationSeconds ?? 0) - (right.durationSeconds ?? 0)),
        )}s), so they are not treated as encodes of the same item.`,
      ],
      uncertainty: ["Compare these records only after the identity match is confirmed; runtime differences usually indicate a different cut."],
      axes: axes.map(finalizeAxis),
      differenceSummary: [],
      left,
      right,
      identical: false,
      rankedDifferences: 0,
    };
  }

  // --- Ranked axes (Pareto dominance inputs). ---
  const codecClass = compareOrdinal(
    "video_codec",
    "ranked",
    left.videoCodecClass,
    right.videoCodecClass,
    (value) => (value === null ? "unknown" : value === 5 ? "VVC" : value === 4 ? "AV1" : value === 3 ? "HEVC/VP9" : value === 2 ? "AVC/H.264" : value === 1 ? "MPEG-4" : value === 0 ? "MPEG-2" : String(value)),
    "Codec generation is an efficiency class, not a quality guarantee; a well-tuned older codec can beat a lazy newer encode.",
  );
  if (codecClass) axes.push(codecClass);

  const sameCodecGeneration =
    left.videoCodecClass !== null && right.videoCodecClass !== null && left.videoCodecClass === right.videoCodecClass;
  const bothClassesKnown = left.videoCodecClass !== null && right.videoCodecClass !== null;
  let bitrateNotComparable = false;
  const containerBitrate = compareNumbers(
    "bitrate",
    "ranked",
    left.containerBitrate,
    right.containerBitrate,
    describeBitrate,
    { higherIsBetter: true, tolerance: 0.02 },
  );
  if (containerBitrate && bothClassesKnown && !sameCodecGeneration && containerBitrate.status !== "equal") {
    // A more efficient codec legitimately spends fewer bits: refuse to rank.
    containerBitrate.materiality = "escalating";
    containerBitrate.status = "different";
    containerBitrate.note =
      "Bitrate is not comparable across codec generations; the lower-bitrate encode may be the more efficient one.";
    bitrateNotComparable = true;
  }
  if (containerBitrate) axes.push(containerBitrate);

  const videoBitrate = compareNumbers(
    "video_bitrate",
    bitrateNotComparable ? "escalating" : "ranked",
    left.videoBitrate,
    right.videoBitrate,
    describeBitrate,
    { higherIsBetter: true, tolerance: 0.02 },
  );
  if (videoBitrate) axes.push(videoBitrate);

  const resolutionHasPixels = left.pixels !== null && right.pixels !== null;
  const resolution = compareNumbers(
    "resolution",
    "ranked",
    resolutionHasPixels ? left.pixels : left.height,
    resolutionHasPixels ? right.pixels : right.height,
    (value) => (value === null ? "unknown" : String(value)),
    { higherIsBetter: true, tolerance: RESOLUTION_TOLERANCE },
  );
  if (resolution) {
    resolution.leftValue = left.resolution;
    resolution.rightValue = right.resolution;
    resolution.note = resolutionHasPixels
      ? `${left.pixels} vs ${right.pixels} pixels per frame`
      : "Full frame dimensions are unavailable on at least one side, so resolution is compared by height only.";
    axes.push(resolution);
  }

  const dynamicRange = compareOrdinal(
    "dynamic_range",
    "ranked",
    left.dynamicRange === "unknown" ? null : left.dynamicRange === "sdr" ? 0 : 1,
    right.dynamicRange === "unknown" ? null : right.dynamicRange === "sdr" ? 0 : 1,
    () => "",
  );
  if (dynamicRange) {
    dynamicRange.leftValue = left.dynamicRange;
    dynamicRange.rightValue = right.dynamicRange;
    if (dynamicRange.status !== "equal") {
      dynamicRange.note =
        "HDR is only an advantage on a capable display and a correctly tone-mapped pipeline; treat this as a preference, not a measurement.";
    }
    axes.push(dynamicRange);
  }

  const bitDepth = compareNumbers(
    "bit_depth",
    "ranked",
    left.bitDepth,
    right.bitDepth,
    (value) => (value === null ? "unknown" : `${value}-bit`),
    { higherIsBetter: true, tolerance: 0 },
  );
  if (bitDepth) axes.push(bitDepth);

  const audioCodec = compareOrdinal(
    "audio_codec",
    "ranked",
    left.audioCodecClass,
    right.audioCodecClass,
    (value) => (value === null ? "unknown" : value === 5 ? "lossless or lossless-compressed" : value === 4 ? "advanced surround lossy" : value === 3 ? "standard lossy" : value === 2 ? "legacy lossy" : String(value)),
    "Audio codec class ranks fidelity type (lossless vs lossy), never perceptual quality between two lossy codecs.",
  );
  if (audioCodec) axes.push(audioCodec);

  const audioChannels = compareNumbers(
    "audio_channels",
    "ranked",
    left.audioChannels,
    right.audioChannels,
    (value) => (value === null ? "unknown" : `${value} ch`),
    { higherIsBetter: true, tolerance: 0 },
  );
  if (audioChannels) {
    if (audioChannels.status !== "equal") {
      audioChannels.note = "Channel count describes the layout, not the mix quality of either track.";
    }
    axes.push(audioChannels);
  }

  const audioBitrate = compareNumbers(
    "audio_bitrate",
    left.audioCodec === right.audioCodec ? "ranked" : "escalating",
    left.audioBitrate ?? null,
    right.audioBitrate ?? null,
    describeBitrate,
    { higherIsBetter: true, tolerance: 0.05 },
  );
  if (audioBitrate && left.audioCodec !== right.audioCodec) {
    audioBitrate.note = "Audio bitrate is only comparable within the same audio codec.";
  }
  if (audioBitrate) axes.push(audioBitrate);

  // --- Escalating but unranked differences. ---
  const framerate = compareNumbers(
    "framerate",
    "escalating",
    left.framerate,
    right.framerate,
    describeFramerate,
    { higherIsBetter: true, tolerance: 0.001 },
  );
  if (framerate && framerate.status !== "equal") {
    framerate.note =
      "Frame rate is a presentation property (motion handling, creative intent), not a quality ordinal; more frames per second is not automatically better.";
  }
  if (framerate) axes.push(framerate);

  const container = compareStrings("container", "informational", left.container, right.container, "Container differences affect compatibility and features, not picture quality.");
  if (container) axes.push(container);

  const videoProfile = compareStrings("video_profile", "informational", left.videoProfile, right.videoProfile);
  if (videoProfile) axes.push(videoProfile);

  const audioLanguages = compareSets("audio_languages", "escalating", left.audioLanguages, right.audioLanguages, "Audio language coverage is an availability difference, not a quality difference.");
  if (audioLanguages) axes.push(audioLanguages);

  const subtitleLanguages = compareSets("subtitle_languages", "escalating", left.subtitleLanguages, right.subtitleLanguages, "Subtitle coverage is an availability difference, not a quality difference.");
  if (subtitleLanguages) axes.push(subtitleLanguages);

  const provenance = compareStrings("source_provenance", "escalating", left.provenance, right.provenance, "Release provenance describes where an encode came from; it is never ranked as a quality measure.");
  if (provenance) axes.push(provenance);

  const leftWhere = left.archiveRoot ?? left.volumeId ?? (left.origin === "plex_media" ? "plex library" : null);
  const rightWhere = right.archiveRoot ?? right.volumeId ?? (right.origin === "plex_media" ? "plex library" : null);
  if (leftWhere !== null || rightWhere !== null) {
    const sameWhere = leftWhere !== null && leftWhere === rightWhere;
    axes.push({
      axis: "location",
      status: sameWhere ? "equal" : "different",
      materiality: "informational",
      leftValue: leftWhere,
      rightValue: rightWhere,
      text: sameWhere ? `both under ${leftWhere}` : `${leftWhere ?? "unknown"} vs ${rightWhere ?? "unknown"}`,
      note: sameWhere
        ? undefined
        : "The copies sit in different locations, which is a storage question rather than a quality one.",
    });
  }

  const finalized = axes.map(finalizeAxis);
  const ranked = finalized.filter((axis) => axis.materiality === "ranked");
  const rankedBetterLeft = ranked.filter((axis) => axis.status === "left_better").length;
  const rankedBetterRight = ranked.filter((axis) => axis.status === "right_better").length;
  const rankedUnknown = ranked.filter((axis) => axis.status === "unknown").length;
  // Only a measured difference counts. An axis that is unknown on one side is
  // recorded as uncertainty, never as a reason to call two encodes different.
  const escalatingDifferences = finalized.filter(
    (axis) =>
      axis.materiality === "escalating"
      && (axis.status === "different" || axis.status === "left_better" || axis.status === "right_better"),
  );
  const rankedDifferences = rankedBetterLeft + rankedBetterRight;
  const differenceSummary = legacyQualityDifferences(left, right);

  // --- Verdict. ---
  let relationship: EncodeRelationship;
  let winner: QualityComparison["winner"] = null;
  let confidence: QualityConfidence | null = null;

  if (checksumsMatch) {
    relationship = "exact_duplicate";
    confidence = "high";
  } else {
    const comparableRanked = ranked.filter((axis) => axis.status !== "unknown").length;
    if (comparableRanked === 0) {
      relationship = "insufficient_metadata";
      confidence = null;
      uncertainty.push(
        "No shared ranked axis could be measured on both sides, so no ordering is possible from the stored metadata.",
      );
    } else if (rankedBetterLeft > 0 && rankedBetterRight > 0) {
      relationship = "materially_different_encode";
      confidence = rankedUnknown ? "low" : "medium";
      uncertainty.push(
        `Each side wins on at least one measured axis (${rankedBetterLeft} for ${left.label}, ${rankedBetterRight} for ${right.label}); the stored metadata cannot express which tradeoff you should prefer.`,
      );
    } else if (rankedBetterLeft > 0 || rankedBetterRight > 0) {
      const advantage = rankedBetterLeft > 0 ? "left" : "right";
      const winnerQuality = advantage === "left" ? left : right;
      const loserQuality = advantage === "left" ? right : left;
      // Resolution gains that arrive with much worse bits-per-pixel are not a
      // proven improvement; downgrade instead of declaring a winner.
      const resolutionAxis = ranked.find((axis) => axis.axis === "resolution");
      const resolutionFavoursWinner =
        resolutionAxis?.status === (advantage === "left" ? "left_better" : "right_better");
      const winnerBpp = winnerQuality.bitsPerPixelFrame;
      const loserBpp = loserQuality.bitsPerPixelFrame;
      const bppInverted =
        resolutionFavoursWinner &&
        winnerBpp !== null &&
        loserBpp !== null &&
        loserBpp > 0 &&
        winnerBpp < loserBpp * BITS_PER_PIXEL_INVERSION_RATIO;
      if (bppInverted) {
        relationship = "materially_different_encode";
        winner = null;
        confidence = "low";
        uncertainty.push(
          `The higher-resolution encode carries about ${Math.round(
            (winnerBpp! / loserBpp!) * 100,
          )}% of the other's bits per pixel, so the extra pixels may be under-supplied or upscaled. No winner is asserted.`,
        );
      } else {
        relationship = advantage === "left" ? "superior_encode" : "inferior_encode";
        winner = advantage;
        const onlyHdr = ranked
          .filter((axis) => axis.status !== "equal" && axis.status !== "unknown")
          .every((axis) => axis.axis === "dynamic_range");
        const decisiveAxes = ranked
          .filter((axis) => axis.status !== "equal" && axis.status !== "unknown")
          .map((axis) => axis.axis.replaceAll("_", " "));
        confidence = rankedUnknown || decisiveAxes.length < 2 ? "medium" : "high";
        if (onlyHdr) {
          confidence = "low";
          uncertainty.push(
            "Only dynamic range separates these encodes; the ordering depends on your display and tone-mapping, not on the file alone.",
          );
        }
        if (rankedUnknown) {
          uncertainty.push(
            `${rankedUnknown} measured axis${rankedUnknown === 1 ? " was" : "s were"} unavailable on one side (${ranked.filter((axis) => axis.status === "unknown").map((axis) => axis.axis.replaceAll("_", " ")).join(", ")}); the ordering holds for what is known but is not complete.`,
          );
        }
        reasons.push(
          `${winnerQuality.label} is at least as good on every comparable measured axis and better on ${decisiveAxes.join(", ")}.`,
        );
        reasons.push(
          `${loserQuality.label} is not better on any measured axis, so this is dominance rather than a tradeoff.`,
        );
      }
    } else if (escalatingDifferences.length) {
      relationship = "materially_different_encode";
      winner = null;
      confidence = escalatingDifferences.every((axis) => axis.axis === "container") ? "medium" : "low";
    } else {
      relationship = checksumsDiffer ? "equivalent" : "probable_duplicate";
      confidence = left.fingerprint && left.fingerprint === right.fingerprint ? "medium" : "low";
      if (relationship === "probable_duplicate" && !checksumsDiffer) {
        confidence = rankedUnknown || left.checksumStatus === "failed" ? "low" : "medium";
      }
    }
  }

  if (relationship === "probable_duplicate") {
    reasons.push(
      "No byte-level proof: the records share media evidence (identity, runtime, stream shape) but at least one checksum is unavailable or different.",
    );
  }
  if (relationship === "equivalent") {
    reasons.push("Every comparable measured axis is equal within tolerance; the encodes are equivalent on the metadata available.");
  }
  if (relationship === "materially_different_encode" && winner === null && !reasons.length) {
    reasons.push(
      escalatingDifferences.length
        ? `Real but unordered differences exist: ${escalatingDifferences.map((axis) => axis.axis.replaceAll("_", " ")).join(", ")}.`
        : "The encodes differ in directions that cannot be ranked against each other.",
    );
  }
  if (bitrateNotComparable) {
    uncertainty.push(
      "Total bitrate was excluded from the ranking because the video codec generations differ; a lower bitrate may simply be a more efficient codec.",
    );
  }
  if (options.sameSemanticItem === false) {
    uncertainty.push("These records were not confirmed as the same semantic item; treat the comparison as exploratory.");
  }
  if (left.origin === "plex_media" || right.origin === "plex_media") {
    uncertainty.push(
      "One side is Plex-derived: Plex exposes fewer per-stream fields than FFprobe, so audio layout, frame rate, and bit depth are unknown rather than equal.",
    );
  }
  if (left.storageScope !== right.storageScope) {
    uncertainty.push(
      `The records live in different scopes (${left.storageScope} vs ${right.storageScope}); a staging copy and a library copy can legitimately coexist.`,
    );
  }

  return {
    relationship,
    winner,
    winnerReference: winner ? (winner === "left" ? left.reference : right.reference) : null,
    confidence,
    reasons,
    uncertainty,
    axes: finalized,
    differenceSummary,
    left,
    right,
    identical: checksumsMatch,
    rankedDifferences,
  };
}

/**
 * Legacy compatibility summary built directly from two models. Kept so the
 * archive inventory and its review evidence keys keep their existing wording
 * while using the same single source of truth.
 */
export function legacyQualityDifferences(left: TechnicalQuality, right: TechnicalQuality): string[] {
  const formatHeight = (value: number | null) => (value === null ? "unknown" : `${value}p`);
  const differences: string[] = [];
  if (left.height !== right.height && (left.height !== null || right.height !== null)) {
    differences.push(`resolution ${formatHeight(left.height)} vs ${formatHeight(right.height)}`);
  }
  const leftHdr = left.dynamicRange !== "sdr" && left.dynamicRange !== "unknown";
  const rightHdr = right.dynamicRange !== "sdr" && right.dynamicRange !== "unknown";
  if (leftHdr !== rightHdr) differences.push(`${leftHdr ? "HDR" : "SDR"} vs ${rightHdr ? "HDR" : "SDR"}`);
  if (left.videoCodec !== right.videoCodec) {
    differences.push(`video codec ${left.videoCodec ?? "unknown"} vs ${right.videoCodec ?? "unknown"}`);
  }
  if (left.containerBitrate !== right.containerBitrate && (left.containerBitrate !== null || right.containerBitrate !== null)) {
    differences.push(`bitrate ${left.containerBitrate ?? "unknown"} vs ${right.containerBitrate ?? "unknown"}`);
  }
  if (left.audioCodec !== right.audioCodec) {
    differences.push(`audio codec ${left.audioCodec ?? "unknown"} vs ${right.audioCodec ?? "unknown"}`);
  }
  if (left.audioChannels !== right.audioChannels && (left.audioChannels !== null || right.audioChannels !== null)) {
    differences.push(`audio channels ${left.audioChannels ?? "unknown"} vs ${right.audioChannels ?? "unknown"}`);
  }
  if (left.container !== right.container) {
    differences.push(`container ${left.container ?? "unknown"} vs ${right.container ?? "unknown"}`);
  }
  return differences;
}

/** Compact per-file snapshot used by the quality findings API and UI. */
export type QualitySnapshot = {
  reference: string;
  fileRecordId: number | null;
  label: string;
  resolution: string;
  width: number | null;
  height: number | null;
  dynamicRange: TechnicalQuality["dynamicRange"];
  videoCodec: string | null;
  videoProfile: string | null;
  bitDepth: number | null;
  framerate: number | null;
  bitrate: number | null;
  audio: string | null;
  audioLanguages: string[];
  subtitleLanguages: string[];
  container: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  checksum: string | null;
  checksumStatus: TechnicalQuality["checksumStatus"];
  provenance: ReleaseProvenance;
  storageScope: TechnicalQuality["storageScope"];
  volumeId: string | null;
  relativePath: string | null;
  technicalMetadataMissing: boolean;
};

export function qualitySnapshot(quality: TechnicalQuality): QualitySnapshot {
  const audioSummary = quality.audioChannels === null
    ? quality.audioCodec
    : `${quality.audioCodec ?? "audio"}${quality.audioChannelLayout ? ` ${quality.audioChannelLayout}` : ` ${quality.audioChannels}ch`}`;
  return {
    reference: quality.reference,
    fileRecordId: quality.origin === "file_record" ? Number(quality.reference.split(":")[1]) : null,
    label: quality.label,
    resolution: quality.resolution,
    width: quality.width,
    height: quality.height,
    dynamicRange: quality.dynamicRange,
    videoCodec: quality.videoCodec,
    videoProfile: quality.videoProfile,
    bitDepth: quality.bitDepth,
    framerate: quality.framerate,
    bitrate: quality.containerBitrate,
    audio: audioSummary,
    audioLanguages: quality.audioLanguages,
    subtitleLanguages: quality.subtitleLanguages,
    container: quality.container,
    durationSeconds: quality.durationSeconds,
    sizeBytes: quality.sizeBytes,
    checksum: quality.checksum,
    checksumStatus: quality.checksumStatus,
    provenance: quality.provenance,
    storageScope: quality.storageScope,
    volumeId: quality.volumeId,
    relativePath: quality.relativePath,
    technicalMetadataMissing: quality.technicalMetadataMissing,
  };
}

export function qualitySummaryLine(quality: TechnicalQuality): string {
  const parts = [
    quality.resolution === "unknown" ? null : quality.resolution,
    quality.videoCodec ? quality.videoCodec.toUpperCase() : null,
    quality.videoProfile ? quality.videoProfile : null,
    quality.bitDepth && quality.bitDepth > 8 ? `${quality.bitDepth}-bit` : null,
    quality.dynamicRange !== "sdr" && quality.dynamicRange !== "unknown" ? quality.dynamicRange.toUpperCase() : null,
    quality.framerate ? `${quality.framerate} fps` : null,
    quality.containerBitrate ? `${Math.round(quality.containerBitrate / 1000)} kbps` : null,
    quality.audioCodec
      ? `${quality.audioCodec.toUpperCase()}${quality.audioChannels ? ` ${quality.audioChannels}ch` : ""}`
      : null,
    quality.container ? quality.container : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" / ") : "no technical metadata";
}
