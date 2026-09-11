export type AcquisitionMediaType = "movie" | "tv";
export type AcquisitionScope = "movie" | "episode" | "season";
export type AvailabilityState = "unavailable" | "available" | "unknown";
export type ArchiveNeedState =
  | "fully_present"
  | "partially_present"
  | "missing"
  | "present_lower_quality"
  | "uncertain";
export type RecommendationStatus = "recommended" | "not_recommended";
export type RecommendationPriority = "high" | "normal" | "low";
export type ReviewState = "unreviewed" | "reviewed" | "deferred" | "dismissed";

export type TechnicalQuality = {
  height: number | null;
  hdr: boolean;
  videoCodec: string | null;
  bitrate: number | null;
  audioCodec: string | null;
  audioChannels: number | null;
  container: string | null;
};

export type SemanticIdentity = {
  key: string;
  title: string;
  mediaType: AcquisitionMediaType;
  year: number | null;
  show: string | null;
  season: number | null;
  episode: number | null;
  confidence: number;
};

export type MediaNeed = {
  identity: SemanticIdentity;
  scope: AcquisitionScope;
  archiveState: ArchiveNeedState;
  presentCount: number;
  expectedCount: number;
  observedCount: number;
  archiveQuality: TechnicalQuality | null;
  archiveSizeBytes: number;
  preferredQuality: TechnicalQuality | null;
  identityConfidence: number;
};

export type Availability = {
  state: AvailabilityState;
  provider: string;
  discoveredTitle: string | null;
  discoveredId: string | null;
  sourceConfidence: number;
  checkedAt: string | null;
};

export type SourceOption = {
  id: number | string;
  provider: string;
  sourceKey?: string;
  title: string;
  mediaType: AcquisitionMediaType;
  scope: AcquisitionScope;
  season: number | null;
  episode: number | null;
  quality: TechnicalQuality | null;
  estimatedSizeBytes: number | null;
  availability: Availability;
  confidence: number;
};

export type StorageCapacity = {
  freeBytes: number | null;
  totalBytes?: number | null;
  status: "ready" | "warning" | "critical" | "unavailable";
  volumeCount?: number;
};

export type StorageImpact = {
  estimatedBytes: number | null;
  freeBytesBefore: number | null;
  freeBytesAfter: number | null;
  status: "sufficient" | "insufficient" | "unknown";
  summary: string;
};

export type AcquisitionRecommendation = {
  status: RecommendationStatus;
  priority: RecommendationPriority;
  reason: string;
  candidateSources: SourceOption[];
  expectedQuality: TechnicalQuality | null;
  expectedStorageImpact: StorageImpact;
  confidence: number;
  blockingReasons: string[];
  archiveState: ArchiveNeedState;
};

const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export function qualityRank(quality: TechnicalQuality | null | undefined) {
  if (!quality) return 0;
  const height = quality.height ?? 0;
  const hdr = quality.hdr ? 5000 : 0;
  const codec = /av1/i.test(quality.videoCodec ?? "")
    ? 300
    : /265|hevc/i.test(quality.videoCodec ?? "")
      ? 250
      : /264/i.test(quality.videoCodec ?? "")
        ? 150
        : 50;
  const bitrate = Math.min(100, Math.round((quality.bitrate ?? 0) / 1_000_000));
  return height + hdr + codec + (quality.audioChannels ?? 0) + bitrate;
}

export function qualityCompleteness(quality: TechnicalQuality | null | undefined) {
  if (!quality) return 0;
  const fields = [quality.height, quality.videoCodec, quality.bitrate, quality.audioCodec, quality.container];
  return fields.filter((value) => value !== null && value !== undefined && value !== "").length / fields.length;
}

export function determineMediaNeedState(input: {
  identityConfidence: number;
  presentCount: number;
  expectedCount?: number;
  observedCount?: number;
  archiveQuality?: TechnicalQuality | null;
  preferredQuality?: TechnicalQuality | null;
}) : ArchiveNeedState {
  if (input.identityConfidence < 0.5) return "uncertain";
  const expectedCount = Math.max(1, Math.trunc(input.expectedCount ?? 1));
  const observedCount = Math.max(0, Math.trunc(input.observedCount ?? input.presentCount));
  const presentCount = Math.max(0, Math.trunc(input.presentCount));
  if (observedCount > 0 && presentCount === 0) return "missing";
  if (presentCount === 0) return "missing";
  if (expectedCount > 1 && presentCount < expectedCount) return "partially_present";
  if (input.preferredQuality && qualityRank(input.archiveQuality) < qualityRank(input.preferredQuality)) {
    return "present_lower_quality";
  }
  return "fully_present";
}

export function calculateConfidence(input: {
  identityConfidence: number;
  sourceConfidence?: number;
  availabilityConfidence?: number;
  qualityConfidence?: number;
  storageConfidence?: number;
}) {
  return Number((
    clamp(input.identityConfidence) * 0.3
    + clamp(input.sourceConfidence ?? 0) * 0.25
    + clamp(input.availabilityConfidence ?? 0) * 0.2
    + clamp(input.qualityConfidence ?? 0) * 0.15
    + clamp(input.storageConfidence ?? 0) * 0.1
  ).toFixed(3));
}

export function storageImpact(estimatedBytes: number | null, storage: StorageCapacity): StorageImpact {
  if (estimatedBytes === null || storage.freeBytes === null || !Number.isFinite(estimatedBytes) || !Number.isFinite(storage.freeBytes)) {
    return {
      estimatedBytes,
      freeBytesBefore: storage.freeBytes,
      freeBytesAfter: null,
      status: "unknown",
      summary: "Storage impact cannot be determined from the available size or capacity metadata.",
    };
  }
  const freeBytesAfter = storage.freeBytes - Math.max(0, estimatedBytes);
  if (freeBytesAfter < 0) {
    return {
      estimatedBytes,
      freeBytesBefore: storage.freeBytes,
      freeBytesAfter,
      status: "insufficient",
      summary: `The option needs ${formatBytes(estimatedBytes)} but only ${formatBytes(storage.freeBytes)} is free.`,
    };
  }
  return {
    estimatedBytes,
    freeBytesBefore: storage.freeBytes,
    freeBytesAfter,
    status: "sufficient",
    summary: `${formatBytes(estimatedBytes)} estimated; ${formatBytes(freeBytesAfter)} would remain.`,
  };
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function availabilityConfidence(state: AvailabilityState) {
  return state === "available" ? 1 : state === "unknown" ? 0.35 : 0;
}

function candidateScore(candidate: SourceOption, impact: StorageImpact) {
  return candidate.confidence * 0.45
    + candidate.availability.sourceConfidence * 0.25
    + qualityCompleteness(candidate.quality) * 0.2
    + (impact.status === "sufficient" ? 0.1 : impact.status === "unknown" ? 0.03 : 0);
}

function priorityFor(need: MediaNeed, hasAvailableCandidate: boolean) : RecommendationPriority {
  if (need.archiveState === "missing" && hasAvailableCandidate) return "high";
  if (need.archiveState === "partially_present" || need.archiveState === "present_lower_quality") return "normal";
  if (need.archiveState === "missing") return "normal";
  return "low";
}

function stateReason(state: ArchiveNeedState) {
  switch (state) {
    case "missing": return "No local archive copy is present for this semantic item.";
    case "partially_present": return "The archive contains only part of the expected season or collection.";
    case "present_lower_quality": return "A local copy exists, but it is below the configured or observed archive quality profile.";
    case "uncertain": return "The existing identity or archive evidence is not reliable enough for an automatic recommendation.";
    default: return "The archive already contains this semantic item.";
  }
}

export function recommendAcquisition(
  need: MediaNeed,
  candidates: SourceOption[],
  storage: StorageCapacity,
): AcquisitionRecommendation {
  const byAvailability = candidates
    .map((candidate) => ({ candidate, impact: storageImpact(candidate.estimatedSizeBytes, storage) }))
    .sort((left, right) => candidateScore(right.candidate, right.impact) - candidateScore(left.candidate, left.impact));
  const available = byAvailability.filter(({ candidate }) => candidate.availability.state === "available");
  const feasible = available.filter(({ impact }) => impact.status !== "insufficient");
  const unknown = byAvailability.filter(({ candidate }) => candidate.availability.state === "unknown");
  const unavailable = candidates.filter((candidate) => candidate.availability.state === "unavailable");
  const chosenPool = feasible.length ? feasible : available.length ? available : unknown;
  const chosen = chosenPool[0];
  const blockingReasons: string[] = [];

  if (need.archiveState === "uncertain") blockingReasons.push("uncertain_identity");
  if (!candidates.length) blockingReasons.push("no_source_option");
  if (!available.length && unknown.length) blockingReasons.push("availability_unknown");
  if (!available.length && !unknown.length && unavailable.length) blockingReasons.push("source_unavailable");
  if (available.length && !feasible.length) blockingReasons.push("insufficient_storage");
  if (chosen && storage.freeBytes === null && chosen.candidate.estimatedSizeBytes !== null) blockingReasons.push("storage_unknown");

  const topCandidates = available.filter((entry) => entry.candidate.availability.sourceConfidence >= (chosen?.candidate.availability.sourceConfidence ?? 0));
  if (topCandidates.length > 1) {
    const scores = [...topCandidates]
      .sort((left, right) => candidateScore(right.candidate, right.impact) - candidateScore(left.candidate, left.impact));
    const first = scores[0];
    const second = scores[1];
    if (first && second
      && Math.abs(candidateScore(first.candidate, first.impact) - candidateScore(second.candidate, second.impact)) < 0.02
      && qualityRank(first.candidate.quality) !== qualityRank(second.candidate.quality)) {
      blockingReasons.push("conflicting_candidates");
    }
  }

  if (need.archiveState === "fully_present" && !candidates.some((candidate) => qualityRank(candidate.quality) > qualityRank(need.archiveQuality))) {
    blockingReasons.push("already_present");
  }

  const candidate = chosen?.candidate ?? byAvailability[0]?.candidate ?? null;
  const impact = chosen?.impact ?? (candidate ? storageImpact(candidate.estimatedSizeBytes, storage) : storageImpact(null, storage));
  const sourceConfidence = candidate?.confidence ?? 0;
  const availability = candidate ? availabilityConfidence(candidate.availability.state) : 0;
  const confidence = calculateConfidence({
    identityConfidence: need.identityConfidence,
    sourceConfidence,
    availabilityConfidence: availability,
    qualityConfidence: qualityCompleteness(candidate?.quality),
    storageConfidence: impact.status === "unknown" ? 0.35 : 1,
  });
  const recommends = Boolean(
    candidate
    && candidate.availability.state === "available"
    && feasible.some(({ candidate: feasibleCandidate }) => feasibleCandidate.id === candidate.id)
    && need.archiveState !== "uncertain"
    && !blockingReasons.includes("conflicting_candidates")
    && !blockingReasons.includes("already_present"),
  );

  const reasonParts = [stateReason(need.archiveState)];
  if (recommends) {
    reasonParts.push(`${candidate!.provider} reports an available option${candidate!.title ? `: ${candidate!.title}` : ""}.`);
  } else if (blockingReasons.includes("source_unavailable")) {
    reasonParts.push("Known source options are currently unavailable.");
  } else if (blockingReasons.includes("availability_unknown")) {
    reasonParts.push("Source availability has not been confirmed.");
  } else if (blockingReasons.includes("insufficient_storage")) {
    reasonParts.push("The available storage cannot accommodate the current options.");
  } else if (blockingReasons.includes("conflicting_candidates")) {
    reasonParts.push("Candidate options conflict on quality or size and need operator review.");
  } else if (blockingReasons.includes("already_present")) {
    reasonParts.push("No candidate improves the current archive profile.");
  } else {
    reasonParts.push("No safe acquisition option is currently available.");
  }

  return {
    status: recommends ? "recommended" : "not_recommended",
    priority: priorityFor(need, recommends),
    reason: reasonParts.join(" "),
    candidateSources: candidates,
    expectedQuality: candidate?.quality ?? null,
    expectedStorageImpact: impact,
    confidence,
    blockingReasons,
    archiveState: need.archiveState,
  };
}
