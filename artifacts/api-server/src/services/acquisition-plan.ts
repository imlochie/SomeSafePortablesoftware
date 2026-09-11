/**
 * AcquisitionPlan — the canonical, provider-neutral object for the
 * URL → Archive vertical slice.
 *
 * ADAPTERS PROVIDE FACTS (yt-dlp inspection, integration discovery, archive
 * inventory). INTELLIGENCE INTERPRETS FACTS (identity resolution, quality
 * comparison, storage impact). POLICY DECIDES WHAT IS ACCEPTABLE (source
 * trust + explicit approval boundary). OPERATIONS EXECUTE APPROVED PLANS
 * (bounded batches through the real download engine, FFmpeg processing,
 * FFprobe verification, archive re-scan, journaled placement).
 *
 * The core never learns about a specific site: the supplied source is a URL
 * descriptor, and alternative sources are discovered through integration
 * capabilities, not hard-coded providers.
 */
import { archiveDb, readSettings, type SettingsRecord } from "../lib/archive-db";
import { inspectMediaSourceEntries, windowsSafeStem } from "./media";
import {
  localEpisodeIdentity,
  normalizeTitle,
  readArchiveInventory,
  titleYear,
} from "./archive";
import { chooseArchiveVolume } from "./storage";
import { qualityRank, storageImpact, type TechnicalQuality } from "./acquisition-engine";
import { join } from "node:path";
import { integrations } from "../integrations";
import { createJob, readJob, startJob } from "./download-engine";
import { readOperation } from "./archive-operations";
import { addEvent } from "../lib/archive-db";

export const SOURCE_TRUST_STATES = ["trusted", "user_approved", "untrusted", "unsupported", "blocked"] as const;
export type SourceTrustState = (typeof SOURCE_TRUST_STATES)[number];

export const PLAN_APPROVAL_STATES = ["pending", "approved", "rejected"] as const;
export type PlanApprovalState = (typeof PLAN_APPROVAL_STATES)[number];

export const PLAN_ITEM_STATES = [
  "planned", "queued", "downloading", "processing", "verifying",
  "downloading_more", "staged", "promoted", "failed", "already_present", "skipped",
] as const;
export type PlanItemState = (typeof PLAN_ITEM_STATES)[number];

/** A single executable acquisition batch never exceeds this many items. */
export const ACQUISITION_PLAN_BATCH_LIMIT = 25;
/** A single plan never considers more discovered entries than this. */
export const ACQUISITION_PLAN_ENTRY_LIMIT = 50;

export type PlanRequest = {
  sourceUrl: string;
  note: string | null;
  mediaType: "movie" | "tv" | null;
  requestedAt: string;
};

export type PlanCandidate = {
  entryUrl: string;
  title: string;
  identityKey: string;
  mediaType: "movie" | "tv";
  scope: "movie" | "episode" | "season";
  season: number | null;
  episode: number | null;
  year: number | null;
  selectedFormatId: string | null;
  quality: TechnicalQuality | null;
  estimatedSizeBytes: number | null;
};

export type PlanArchiveState = {
  identityKey: string;
  presentCount: number;
  archiveQuality: TechnicalQuality | null;
  archiveSizeBytes: number;
};

export type PlanQualityComparison = {
  identityKey: string;
  candidateRank: number;
  archiveRank: number | null;
  verdict: "new_item" | "upgrade" | "lateral_or_worse";
  summary: string;
};

export type PlanDestination = {
  identityKey: string;
  volumeId: string;
  volumeLabel: string;
  destinationDirectory: string;
  finalFilename: string;
  mediaType: "movie" | "tv";
};

export type PlanStorageImpact = {
  estimatedBytes: number | null;
  freeBytesBefore: number | null;
  freeBytesAfter: number | null;
  // Canonical storage vocabulary, shared with the acquisition engine's
  // StorageImpact and the /acquisition/findings contract: sufficient,
  // insufficient, unknown. The plan passes the engine's status through
  // verbatim; no value is converted at any boundary.
  status: "sufficient" | "insufficient" | "unknown";
  summary: string;
};

export type PlanItemExecution = {
  identityKey: string;
  title: string;
  state: PlanItemState;
  downloadJobId: number | null;
  error: string | null;
  destinationPath: string | null;
};

export type AcquisitionPlan = {
  id: number;
  request: PlanRequest;
  suppliedSource: {
    url: string;
    extractor: string | null;
    title: string;
    kind: "url";
  };
  sourceTrust: {
    state: SourceTrustState;
    reason: string;
    requiresApproval: boolean;
  };
  discoveredCandidates: PlanCandidate[];
  existingArchiveState: PlanArchiveState[];
  missingItems: PlanCandidate[];
  alreadyPresentItems: PlanCandidate[];
  preferredCandidates: PlanCandidate[];
  qualityComparison: PlanQualityComparison[];
  storageImpact: PlanStorageImpact;
  approvalState: PlanApprovalState;
  approvalNote: string | null;
  executionStrategy: {
    mode: "staged_download";
    batchLimit: number;
    perItem: "download_then_ffmpeg_then_ffprobe_verify";
  };
  destinationPlan: PlanDestination[];
  integrationAlternatives: Array<{ provider: string; capability: string; available: boolean }>;
  items: PlanItemExecution[];
  finalResults: {
    placedCount: number;
    failedCount: number;
    alreadyPresentCount: number;
    perItem: Array<{ identityKey: string; title: string; state: PlanItemState; destinationPath: string | null; error: string | null }>;
  } | null;
};

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
];

/**
 * Source trust policy, pre-inspection phase: scheme and host checks that must
 * pass before yt-dlp is allowed to fetch anything from the source. Loopback,
 * link-local, and private network targets are blocked outright (never
 * fetched, no approval path); non-HTTP schemes are unsupported.
 */
function preInspectionTrust(url: string): { state: SourceTrustState; reason: string; requiresApproval: boolean } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { state: "unsupported", reason: "The supplied source is not a valid URL.", requiresApproval: false };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { state: "unsupported", reason: `The ${parsed.protocol.replace(":", "")} scheme is not supported; only HTTP and HTTPS sources can be inspected.`, requiresApproval: false };
  }
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) {
    return { state: "blocked", reason: `The host '${parsed.hostname}' is blocked by source policy (loopback, link-local, or private network targets are never fetched).`, requiresApproval: false };
  }
  return null;
}

/**
 * Post-inspection trust: an arbitrary user-supplied web URL that yt-dlp can
 * inspect is still untrusted — it is planned read-only and requires an
 * explicit, recorded approval before anything is downloaded.
 */
function postInspectionTrust(inspectionOk: boolean, usableCandidates: number): { state: SourceTrustState; reason: string; requiresApproval: boolean } {
  if (!inspectionOk || usableCandidates === 0) {
    return { state: "unsupported", reason: "The source could not be inspected, or exposes no usable media formats through yt-dlp.", requiresApproval: false };
  }
  return {
    state: "untrusted",
    reason: "The source was supplied directly and is not a configured integration; it is inspected read-only and requires explicit approval before anything is downloaded.",
    requiresApproval: true,
  };
}

function identityForCandidate(title: string, mediaTypeHint: "movie" | "tv" | null): {
  identityKey: string; mediaType: "movie" | "tv"; scope: "movie" | "episode" | "season";
  season: number | null; episode: number | null; year: number | null;
} {
  const episode = localEpisodeIdentity(title);
  const year = titleYear(title);
  if (episode) {
    return {
      identityKey: `tv:${episode.show}:${episode.season}:${episode.episode}`,
      mediaType: "tv",
      scope: "episode",
      season: episode.season,
      episode: episode.episode,
      year,
    };
  }
  const normalizedTitle = normalizeTitle(title);
  const mediaType = mediaTypeHint ?? "movie";
  if (mediaType === "tv") {
    return {
      identityKey: `tv:${normalizedTitle}:${year ?? ""}`,
      mediaType: "tv",
      scope: "season",
      season: null,
      episode: null,
      year,
    };
  }
  return {
    identityKey: `movie:${normalizedTitle}:${year ?? ""}`,
    mediaType: "movie",
    scope: "movie",
    season: null,
    episode: null,
    year,
  };
}

/** Candidate quality is derived from the same normalized yt-dlp format data the inspection endpoint returns. */
function candidateQuality(format: { height: number | null; videoCodec: string | null; bitrate: number | null; audioCodec: string | null; dynamicRange: string | null } | null): TechnicalQuality | null {
  if (!format) return null;
  return {
    height: format.height,
    hdr: Boolean(format.dynamicRange && /hdr|smpte2084|arib-std-b67|hlg/i.test(format.dynamicRange)),
    videoCodec: format.videoCodec,
    bitrate: format.bitrate,
    audioCodec: format.audioCodec,
    audioChannels: null,
    container: null,
  };
}

function archiveQualityOf(record: {
  height: number | null; videoCodec: string | null; bitrate: number | null;
  audioCodec: string | null; audioChannels: number | null; container: string | null; dynamicRange: string | null;
}): TechnicalQuality {
  return {
    height: record.height,
    hdr: Boolean(record.dynamicRange && /hdr|smpte2084|arib-std-b67|hlg/i.test(record.dynamicRange)),
    videoCodec: record.videoCodec,
    bitrate: record.bitrate,
    audioCodec: record.audioCodec,
    audioChannels: record.audioChannels,
    container: record.container,
  };
}

type InventoryRecord = ReturnType<typeof readArchiveInventory>["records"][number];

function archiveStatesFor(ownerId: string): Map<string, PlanArchiveState> {
  const states = new Map<string, PlanArchiveState>();
  for (const record of readArchiveInventory(ownerId).records as InventoryRecord[]) {
    if (!record.identityKey) continue;
    const quality = archiveQualityOf(record);
    const existing = states.get(record.identityKey);
    if (existing) {
      existing.presentCount += 1;
      existing.archiveSizeBytes += record.sizeBytes ?? 0;
      if (qualityRank(quality) > qualityRank(existing.archiveQuality)) {
        existing.archiveQuality = quality;
      }
    } else {
      states.set(record.identityKey, {
        identityKey: record.identityKey,
        presentCount: 1,
        archiveQuality: quality,
        archiveSizeBytes: record.sizeBytes ?? 0,
      });
    }
  }
  return states;
}

/**
 * The Plex-safe destination a plan prepares for a candidate: TV episodes land
 * in a show/season directory, movies at the volume root with a year-suffixed
 * name. This is the acquisition plan's own destination — the naming pipeline
 * stays the authority for restructuring media that is already archived, and
 * intake shows its proposal alongside without letting it jump that queue.
 */
export function plexSafeDestination(candidate: PlanCandidate, volumePath: string, container: string): { directory: string; filename: string } {
  // Windows-safe sanitizing: forbidden characters, control characters,
  // collapsed whitespace, and no trailing dots or spaces (which Windows
  // strips, silently changing the name the archive just recorded).
  const sanitize = (value: string) => windowsSafeStem(
    value
      .replace(/[:<>"\\/\\|?*\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, ""),
  );
  if (candidate.mediaType === "tv" && candidate.season !== null) {
    // "Show S01E02 Reunion" -> show "Show", episode file "Show S01E02".
    const marker = /\bS(\d{1,2})E(\d{1,2})\b/i.exec(candidate.title);
    const show = sanitize(marker ? candidate.title.slice(0, marker.index) : candidate.title) || "Unknown Show";
    const episode = candidate.episode ?? (marker ? Number(marker[2]) : null);
    const season = candidate.season;
    const filename = episode !== null
      ? `${show} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}.${container}`
      : `${show} S${String(season).padStart(2, "0")}.${container}`;
    return { directory: join(volumePath, show, `Season ${String(season).padStart(2, "0")}`), filename };
  }
  const title = sanitize(candidate.title) || "acquisition";
  const filename = candidate.year ? `${title} (${candidate.year}).${container}` : `${title}.${container}`;
  return { directory: volumePath, filename };
}

export type BuildPlanInput = {
  sourceUrl: string;
  note?: string | null;
  mediaType?: "movie" | "tv" | null;
  maxItems?: number | null;
};

/**
 * Build (and persist) an AcquisitionPlan from a supplied source URL. This is
 * a read-only operation against the source (yt-dlp inspection with
 * --skip-download) and the archive; nothing is downloaded and no mutation
 * happens. Untrusted sources stay untrusted until approveAcquisitionPlan.
 */
export async function buildAcquisitionPlan(ownerId: string, input: BuildPlanInput, settings: SettingsRecord = readSettings()): Promise<AcquisitionPlan> {
  const parsedUrl = new URL(input.sourceUrl);
  const mediaTypeHint = input.mediaType ?? null;
  const maxItems = Math.max(1, Math.min(ACQUISITION_PLAN_ENTRY_LIMIT, input.maxItems ?? ACQUISITION_PLAN_ENTRY_LIMIT));

  // Trust phase 1: scheme and host policy gate the inspection fetch itself.
  const preTrust = preInspectionTrust(parsedUrl.toString());

  let inspection: Awaited<ReturnType<typeof inspectMediaSourceEntries>>;
  let inspectionOk = true;
  if (preTrust) {
    inspectionOk = false;
    inspection = {
      metadata: {
        title: "Uninspected source", uploader: null, channel: null, description: null,
        durationSeconds: null, uploadDate: null, thumbnailUrl: null,
        webpageUrl: parsedUrl.toString(), extractor: null, sourceId: null,
        playlistTitle: null, playlistIndex: null,
      },
      formats: [], rawFormatCount: 0, recommendedFormatId: null,
      recommendedVideoFormatId: null, recommendedAudioFormatId: null,
      recommendationExplanation: preTrust.reason,
      demoMode: false,
      cachedAt: new Date().toISOString(),
      entries: [],
    };
  } else {
    try {
      inspection = await inspectMediaSourceEntries(parsedUrl.toString(), settings);
    } catch {
      inspectionOk = false;
      inspection = {
        metadata: {
          title: "Uninspected source", uploader: null, channel: null, description: null,
          durationSeconds: null, uploadDate: null, thumbnailUrl: null,
          webpageUrl: parsedUrl.toString(), extractor: null, sourceId: null,
          playlistTitle: null, playlistIndex: null,
        },
        formats: [], rawFormatCount: 0, recommendedFormatId: null,
        recommendedVideoFormatId: null, recommendedAudioFormatId: null,
        recommendationExplanation: "The source could not be inspected.",
        demoMode: false,
        cachedAt: new Date().toISOString(),
        entries: [],
      };
    }
  }

  // Normalize every discovered entry into a media candidate through the same
  // identity rules the archive scanner uses.
  const seen = new Set<string>();
  const candidates: PlanCandidate[] = [];
  for (const entry of inspection.entries.slice(0, maxItems)) {
    const title = entry.metadata.title ?? "Untitled media";
    const identity = identityForCandidate(title, mediaTypeHint);
    if (seen.has(identity.identityKey)) continue;
    seen.add(identity.identityKey);
    const bestFormat = entry.formats.find((format) => format.formatId === entry.recommendedFormatId)
      ?? entry.formats[0]
      ?? null;
    candidates.push({
      entryUrl: entry.entryUrl,
      title,
      identityKey: identity.identityKey,
      mediaType: identity.mediaType,
      scope: identity.scope,
      season: identity.season,
      episode: identity.episode,
      year: identity.year,
      selectedFormatId: bestFormat?.formatId ?? null,
      quality: candidateQuality(bestFormat ? { height: bestFormat.height, videoCodec: bestFormat.videoCodec, bitrate: bestFormat.bitrate, audioCodec: bestFormat.audioCodec, dynamicRange: bestFormat.dynamicRange } : null),
      estimatedSizeBytes: bestFormat?.filesize ?? bestFormat?.estimatedFilesize ?? null,
    });
  }

  const trust = preTrust ?? postInspectionTrust(inspectionOk, candidates.length);

  // Resolve against the local archive identity.
  const archiveStates = archiveStatesFor(ownerId);
  const missingItems = candidates.filter((candidate) => !archiveStates.has(candidate.identityKey));
  const alreadyPresentItems = candidates.filter((candidate) => archiveStates.has(candidate.identityKey));
  const preferredCandidates = missingItems.filter((candidate) => candidate.selectedFormatId !== null);

  // Quality comparison: candidate vs the best existing archive copy.
  const qualityComparison: PlanQualityComparison[] = candidates.map((candidate) => {
    const archiveState = archiveStates.get(candidate.identityKey);
    const candidateRank = qualityRank(candidate.quality);
    if (!archiveState) {
      return {
        identityKey: candidate.identityKey,
        candidateRank,
        archiveRank: null,
        verdict: "new_item" as const,
        summary: "Not present in the archive; acquiring it adds new media.",
      };
    }
    const archiveRank = qualityRank(archiveState.archiveQuality);
    if (candidateRank > archiveRank) {
      return {
        identityKey: candidate.identityKey,
        candidateRank,
        archiveRank,
        verdict: "upgrade" as const,
        summary: "The candidate is measurably better than the best local copy.",
      };
    }
    return {
      identityKey: candidate.identityKey,
      candidateRank,
      archiveRank,
      verdict: "lateral_or_worse" as const,
      summary: "The archive already holds a copy at least as good as this candidate.",
    };
  });

  // Storage impact over the missing items only, via the shared engine.
  const estimatedBytes = preferredCandidates.reduce((sum, candidate) => sum + (candidate.estimatedSizeBytes ?? 0), 0) || null;
  const targetVolume = preferredCandidates.length
    ? chooseArchiveVolume(settings, preferredCandidates[0].mediaType)
    : null;
  const impact = storageImpact(estimatedBytes, {
    freeBytes: targetVolume?.freeBytes ?? null,
    status: targetVolume ? "ready" : "unavailable",
  });

  // Destination plan: volume selection and Plex-safe filenames, one per item.
  const destinationPlan: PlanDestination[] = preferredCandidates.map((candidate) => {
    const volume = chooseArchiveVolume(settings, candidate.mediaType);
    const container = settings.outputContainer || "mkv";
    const destination = plexSafeDestination(candidate, volume?.path ?? settings.archiveDirectory, container);
    return {
      identityKey: candidate.identityKey,
      volumeId: volume?.id ?? null as unknown as string,
      volumeLabel: volume?.label ?? "Unassigned volume",
      destinationDirectory: destination.directory,
      finalFilename: destination.filename,
      mediaType: candidate.mediaType,
    };
  });

  // Integration capabilities that could offer better alternatives (facts only).
  const integrationAlternatives = [
    ...integrations.discover(ownerId, "search_source").map((d) => ({ provider: d.id, capability: "search_source", available: true })),
    ...integrations.discover(ownerId, "availability_lookup").map((d) => ({ provider: d.id, capability: "availability_lookup", available: true })),
  ];

  const planCore = {
    request: {
      sourceUrl: parsedUrl.toString(),
      note: input.note ?? null,
      mediaType: mediaTypeHint,
      requestedAt: new Date().toISOString(),
    },
    suppliedSource: {
      url: parsedUrl.toString(),
      extractor: inspection.metadata.extractor,
      title: inspection.metadata.title,
      kind: "url" as const,
    },
    sourceTrust: trust,
    discoveredCandidates: candidates,
    existingArchiveState: [...archiveStates.values()].filter((state) => seen.has(state.identityKey)),
    missingItems,
    alreadyPresentItems,
    preferredCandidates,
    qualityComparison,
    storageImpact: {
      estimatedBytes: impact.estimatedBytes,
      freeBytesBefore: impact.freeBytesBefore,
      freeBytesAfter: impact.freeBytesAfter,
      status: impact.status,
      summary: impact.summary,
    },
    approvalState: "pending" as PlanApprovalState,
    approvalNote: null,
    executionStrategy: {
      mode: "staged_download" as const,
      batchLimit: ACQUISITION_PLAN_BATCH_LIMIT,
      perItem: "download_then_ffmpeg_then_ffprobe_verify" as const,
    },
    destinationPlan,
    integrationAlternatives,
    items: preferredCandidates.map((candidate) => ({
      identityKey: candidate.identityKey,
      title: candidate.title,
      state: "planned" as PlanItemState,
      downloadJobId: null,
      error: null,
      destinationPath: null,
    })),
    finalResults: null,
  };

  const result = archiveDb.prepare(`
    INSERT INTO acquisition_plan (owner_id, source_url, request_note, source_trust, trust_reason, approval_state, plan_json)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    ownerId,
    planCore.request.sourceUrl,
    planCore.request.note,
    trust.state,
    trust.reason,
    JSON.stringify(planCore),
  );
  const planId = Number(result.lastInsertRowid);
  for (const candidate of preferredCandidates) {
    const destination = destinationPlan.find((entry) => entry.identityKey === candidate.identityKey);
    archiveDb.prepare(`
      INSERT INTO acquisition_plan_item (owner_id, plan_id, identity_key, title, media_type, scope, entry_url, selected_format_id, destination_directory, final_filename, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')
    `).run(
      ownerId, planId, candidate.identityKey, candidate.title, candidate.mediaType, candidate.scope,
      candidate.entryUrl, candidate.selectedFormatId, destination?.destinationDirectory ?? null, destination?.finalFilename ?? null,
    );
  }
  addEvent("info", `Acquisition plan ${planId} built from ${planCore.request.sourceUrl} (${missingItems.length} missing of ${candidates.length} discovered)`, "acquisition-plan", ownerId);
  return readAcquisitionPlan(ownerId, planId) as AcquisitionPlan;
}

function rowToPlan(ownerId: string, row: {
  id: number; source_url: string; source_trust: string; trust_reason: string;
  approval_state: string; approval_note: string | null; plan_json: string;
}): AcquisitionPlan | null {
  let core;
  try {
    core = JSON.parse(row.plan_json);
  } catch {
    return null;
  }
  const itemRows = archiveDb.prepare(
    "SELECT * FROM acquisition_plan_item WHERE owner_id = ? AND plan_id = ? ORDER BY id",
  ).all(ownerId, row.id) as Array<{
    id: number; identity_key: string; title: string; state: string;
    download_job_id: number | null; operation_id: number | null; error: string | null;
    destination_directory: string | null; final_filename: string | null;
  }>;

  // Live execution state: the persisted snapshot is joined with current job
  // status so per-item state reflects the real download pipeline.
  const items: PlanItemExecution[] = itemRows.map((item) => {
    let state = item.state as PlanItemState;
    let error = item.error;
    let destinationPath: string | null = null;
    if (item.download_job_id !== null) {
      const job = readJob(item.download_job_id, ownerId);
      if (job) {
        if (job.status === "queued") state = "queued";
        else if (job.status === "downloading") state = "downloading";
        else if (job.status === "processing") state = "processing";
        else if (job.status === "verifying") state = "verifying";
        else if (job.status === "moving") state = "downloading_more";
        else if (job.status === "complete") {
          // The verified file is on disk; only the intake promotion (a
          // journaled archive operation) makes it a permanent archive member.
          const promotion = item.operation_id !== null ? readOperation(ownerId, item.operation_id) : null;
          if (promotion && promotion.status === "succeeded") {
            state = "promoted";
            destinationPath = promotion.targetPath;
          } else {
            state = "staged";
            destinationPath = job.finalPath ?? null;
          }
        } else if (job.status === "failed" || job.status === "cancelled" || job.status === "recovery_required") {
          state = "failed";
          error = job.errorMessage ?? "The download did not complete.";
        }
        if (state !== "promoted" && state !== "failed" && !destinationPath && job.finalPath) destinationPath = job.finalPath;
      }
    }
    return {
      identityKey: item.identity_key,
      title: item.title,
      state,
      downloadJobId: item.download_job_id,
      error,
      destinationPath,
    };
  });

  // Final results are derived, not stored: once every item reached a terminal
  // state (promoted, failed, or already present), the plan reports its outcome.
  const terminal = items.length > 0 && items.every((item) => item.state === "promoted" || item.state === "failed" || item.state === "already_present");
  const finalResults = terminal
    ? {
        placedCount: items.filter((item) => item.state === "promoted").length,
        failedCount: items.filter((item) => item.state === "failed").length,
        alreadyPresentCount: items.filter((item) => item.state === "already_present").length,
        perItem: items.map((item) => ({
          identityKey: item.identityKey,
          title: item.title,
          state: item.state,
          destinationPath: item.destinationPath,
          error: item.error,
        })),
      }
    : null;

  return {
    id: row.id,
    ...core,
    sourceTrust: { ...core.sourceTrust, state: row.source_trust, reason: row.trust_reason },
    approvalState: row.approval_state,
    approvalNote: row.approval_note,
    items,
    finalResults,
  };
}

type AcquisitionPlanRow = {
  id: number; source_url: string; source_trust: string; trust_reason: string;
  approval_state: string; approval_note: string | null; plan_json: string;
};

export function readAcquisitionPlan(ownerId: string, planId: number): AcquisitionPlan | null {
  const row = archiveDb.prepare(
    "SELECT * FROM acquisition_plan WHERE owner_id = ? AND id = ?",
  ).get(ownerId, planId) as AcquisitionPlanRow | undefined;
  if (!row) return null;
  return rowToPlan(ownerId, row);
}

export function listAcquisitionPlans(ownerId: string, limit = 20): AcquisitionPlan[] {
  const rows = archiveDb.prepare(
    "SELECT * FROM acquisition_plan WHERE owner_id = ? ORDER BY id DESC LIMIT ?",
  ).all(ownerId, limit) as AcquisitionPlanRow[];
  return rows.map((row) => rowToPlan(ownerId, row)).filter((plan): plan is AcquisitionPlan => plan !== null);
}

/**
 * The approval boundary. An untrusted, explicitly user-supplied source is
 * never silently executed: it must pass through this recorded decision first,
 * which also transitions its trust state to user_approved.
 */
export function approveAcquisitionPlan(ownerId: string, planId: number, note: string | null = null): AcquisitionPlan {
  const plan = readAcquisitionPlan(ownerId, planId);
  if (!plan) throw new Error("Acquisition plan not found.");
  if (plan.sourceTrust.state === "blocked" || plan.sourceTrust.state === "unsupported") {
    throw new Error(`This source is ${plan.sourceTrust.state} and cannot be approved: ${plan.sourceTrust.reason}`);
  }
  if (plan.approvalState === "approved") return plan;
  if (plan.approvalState === "rejected") throw new Error("This plan was rejected; build a new plan to reconsider the source.");
  const trustAfterApproval: SourceTrustState = plan.sourceTrust.state === "untrusted" ? "user_approved" : plan.sourceTrust.state;
  archiveDb.prepare(`
    UPDATE acquisition_plan SET source_trust = ?, approval_state = 'approved', approval_note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE owner_id = ? AND id = ?
  `).run(trustAfterApproval, note, ownerId, planId);
  addEvent("info", `Acquisition plan ${planId} approved (${trustAfterApproval})`, "acquisition-plan", ownerId);
  return readAcquisitionPlan(ownerId, planId) as AcquisitionPlan;
}

export function rejectAcquisitionPlan(ownerId: string, planId: number, note: string | null = null): AcquisitionPlan {
  const plan = readAcquisitionPlan(ownerId, planId);
  if (!plan) throw new Error("Acquisition plan not found.");
  archiveDb.prepare(`
    UPDATE acquisition_plan SET approval_state = 'rejected', approval_note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE owner_id = ? AND id = ?
  `).run(note, ownerId, planId);
  addEvent("info", `Acquisition plan ${planId} rejected`, "acquisition-plan", ownerId);
  return readAcquisitionPlan(ownerId, planId) as AcquisitionPlan;
}

/**
 * Execute an approved plan: a bounded batch of acquisition work through the
 * REAL yt-dlp download engine (FFmpeg processing and FFprobe verification
 * included). Unapproved, blocked, and unsupported plans never reach this path.
 */
export function executeAcquisitionPlan(ownerId: string, planId: number, settings: SettingsRecord = readSettings()): AcquisitionPlan {
  const plan = readAcquisitionPlan(ownerId, planId);
  if (!plan) throw new Error("Acquisition plan not found.");
  if (plan.approvalState !== "approved") {
    throw new Error(`This plan is not approved (state: ${plan.approvalState}); an untrusted source must be explicitly approved first.`);
  }
  if (plan.sourceTrust.state === "blocked" || plan.sourceTrust.state === "unsupported") {
    throw new Error(`This source is ${plan.sourceTrust.state} and can never be executed.`);
  }

  const itemRows = archiveDb.prepare(
    "SELECT * FROM acquisition_plan_item WHERE owner_id = ? AND plan_id = ? AND state = 'planned' ORDER BY id LIMIT ?",
  ).all(ownerId, planId, ACQUISITION_PLAN_BATCH_LIMIT) as Array<{
    id: number; identity_key: string; title: string; entry_url: string;
    selected_format_id: string | null; destination_directory: string | null; final_filename: string | null;
  }>;
  if (!itemRows.length) {
    throw new Error("Nothing left to execute: every item is already queued, present, or failed.");
  }

  for (const item of itemRows) {
    // The real engine handles: temporary-directory fallback, format selection,
    // yt-dlp download, FFmpeg processing, FFprobe verification, and its own
    // safe move of the verified file into the archive volume. The final
    // destination is deliberately NOT handed over: the plan's destination is
    // what the intake promotion moves the file to through the mutation
    // journal, so nothing reaches its permanent archive path except via a
    // journaled, rollbackable operation.
    const job = createJob({
      sourceUrl: item.entry_url,
      title: item.title,
      selectedFormatId: item.selected_format_id ?? "best",
    }, ownerId, settings);
    if (!job) throw new Error(`The download engine could not create a job for '${item.title}'.`);
    archiveDb.prepare(`
      UPDATE acquisition_plan_item SET state = 'queued', download_job_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE owner_id = ? AND id = ?
    `).run(job.id, ownerId, item.id);
    // The real engine pipeline: yt-dlp download → FFmpeg processing → FFprobe
    // verification → move into the destination volume.
    startJob(job.id, ownerId);
  }

  addEvent("info", `Acquisition plan ${planId} executing: ${itemRows.length} item(s) queued through the download engine`, "acquisition-plan", ownerId);
  return readAcquisitionPlan(ownerId, planId) as AcquisitionPlan;
}
