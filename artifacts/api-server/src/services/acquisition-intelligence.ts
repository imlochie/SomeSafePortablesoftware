import { archiveDb, readSettings } from "../lib/archive-db";
import { getArchiveVolumes } from "./storage";
import { readNormalizedMediaStates, type NormalizedMediaState } from "./reconciliation";
import {
  calculateConfidence,
  determineMediaNeedState,
  qualityRank,
  recommendAcquisition,
  storageImpact,
  type AcquisitionRecommendation,
  type AcquisitionScope,
  type AvailabilityState,
  type MediaNeed,
  type SemanticIdentity,
  type SourceOption,
  type StorageCapacity,
  type TechnicalQuality,
  type ReviewState,
} from "./acquisition-engine";

export type AcquisitionFindingStatus = "recommended" | "not_recommended";
export type AcquisitionPriority = "high" | "normal" | "low";

export type AcquisitionCandidateInput = {
  identityKey: string;
  title: string;
  mediaType: "movie" | "tv";
  scope: AcquisitionScope;
  year?: number | null;
  show?: string | null;
  season?: number | null;
  episode?: number | null;
  provider: string;
  sourceKey?: string;
  discoveredId?: string | null;
  quality?: TechnicalQuality | null;
  estimatedSizeBytes?: number | null;
  availabilityState: AvailabilityState;
  sourceConfidence?: number;
  checkedAt?: string | null;
  confidence?: number;
};

type CandidateRow = AcquisitionCandidateInput & { id: number; need_id: number | null };
type NeedRow = {
  id: number;
  owner_id: string;
  identity_key: string;
  title: string;
  media_type: "movie" | "tv";
  scope: AcquisitionScope;
  year: number | null;
  show_identity: string | null;
  season_number: number | null;
  episode_number: number | null;
  archive_state: MediaNeed["archiveState"];
  present_count: number;
  expected_count: number;
  observed_count: number;
  archive_quality_json: string | null;
  archive_size_bytes: number;
  preferred_quality_json: string | null;
  identity_confidence: number;
};

function clamp(value: number | null | undefined) {
  return Math.max(0, Math.min(1, Number.isFinite(value ?? NaN) ? Number(value) : 0));
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function quality(value: string | null | undefined) {
  return parseJson<TechnicalQuality | null>(value, null);
}

function storageFor(mediaType: "movie" | "tv"): StorageCapacity {
  const settings = readSettings();
  const volumes = getArchiveVolumes(settings).filter((volume) => volume.mediaType === mediaType);
  const readable = volumes.filter((volume) => volume.exists && volume.writable && volume.freeBytes !== null);
  if (!readable.length) {
    return { freeBytes: null, totalBytes: null, status: "unavailable", volumeCount: volumes.length };
  }
  const freeBytes = readable.reduce((total, volume) => total + (volume.freeBytes ?? 0), 0);
  return {
    freeBytes,
    totalBytes: null,
    status: freeBytes <= 0 ? "critical" : "ready",
    volumeCount: readable.length,
  };
}

function sourceFromRow(row: CandidateRow): SourceOption {
  return {
    id: row.id,
    provider: row.provider,
    sourceKey: row.sourceKey,
    title: row.title,
    mediaType: row.mediaType,
    scope: row.scope,
    season: row.season ?? null,
    episode: row.episode ?? null,
    quality: row.quality ?? null,
    estimatedSizeBytes: row.estimatedSizeBytes ?? null,
    availability: {
      state: row.availabilityState,
      provider: row.provider,
      discoveredTitle: row.title,
      discoveredId: row.discoveredId ?? null,
      sourceConfidence: clamp(row.sourceConfidence),
      checkedAt: row.checkedAt ?? null,
    },
    confidence: clamp(row.confidence),
  };
}

function sourceRows(ownerId: string): CandidateRow[] {
  const rows = archiveDb.prepare(`
    SELECT id, need_id, identity_key, title, media_type, scope,
           season_number, episode_number, provider, source_key, discovered_id,
           quality_json, estimated_size_bytes, availability_state,
           source_confidence, checked_at, candidate_confidence
    FROM acquisition_source_option
    WHERE owner_id = ?
    ORDER BY id
  `).all(ownerId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    need_id: row.need_id == null ? null : Number(row.need_id),
    identityKey: String(row.identity_key),
    title: String(row.title),
    mediaType: String(row.media_type) as "movie" | "tv",
    scope: String(row.scope) as AcquisitionScope,
    year: null,
    show: null,
    season: row.season_number == null ? null : Number(row.season_number),
    episode: row.episode_number == null ? null : Number(row.episode_number),
    provider: String(row.provider),
    sourceKey: String(row.source_key),
    discoveredId: row.discovered_id == null ? null : String(row.discovered_id),
    quality: quality(row.quality_json as string | null),
    estimatedSizeBytes: row.estimated_size_bytes == null ? null : Number(row.estimated_size_bytes),
    availabilityState: String(row.availability_state) as AvailabilityState,
    sourceConfidence: Number(row.source_confidence ?? 0),
    checkedAt: row.checked_at == null ? null : String(row.checked_at),
    confidence: Number(row.candidate_confidence ?? 0),
  }));
}

function normalizedNeed(state: NormalizedMediaState): MediaNeed {
  return {
    identity: state.identity,
    scope: state.scope,
    archiveState: state.archiveState,
    presentCount: state.presentCount,
    expectedCount: state.expectedCount,
    observedCount: state.observedCount,
    archiveQuality: state.local.bestQuality,
    archiveSizeBytes: state.local.sizeBytes,
    preferredQuality: state.host.bestQuality,
    identityConfidence: state.identityConfidence,
  };
}

function candidateOnlyNeed(candidate: CandidateRow): MediaNeed {
  const identity: SemanticIdentity = {
    key: candidate.identityKey,
    title: candidate.title,
    mediaType: candidate.mediaType,
    year: candidate.year ?? null,
    show: candidate.show ?? null,
    season: candidate.season ?? null,
    episode: candidate.episode ?? null,
    confidence: 0.65,
  };
  return {
    identity,
    scope: candidate.scope,
    archiveState: "missing",
    presentCount: 0,
    expectedCount: 1,
    observedCount: 0,
    archiveQuality: null,
    archiveSizeBytes: 0,
    preferredQuality: null,
    identityConfidence: identity.confidence,
  };
}

function updateNeed(ownerId: string, need: MediaNeed) {
  archiveDb.prepare(`
    INSERT INTO acquisition_need
      (owner_id, identity_key, title, media_type, scope, year, show_identity,
       season_number, episode_number, archive_state, present_count, expected_count,
       observed_count, archive_quality_json, archive_size_bytes, preferred_quality_json,
       identity_confidence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(owner_id, identity_key, scope) DO UPDATE SET
      title = excluded.title,
      media_type = excluded.media_type,
      year = excluded.year,
      show_identity = excluded.show_identity,
      season_number = excluded.season_number,
      episode_number = excluded.episode_number,
      archive_state = excluded.archive_state,
      present_count = excluded.present_count,
      expected_count = excluded.expected_count,
      observed_count = excluded.observed_count,
      archive_quality_json = excluded.archive_quality_json,
      archive_size_bytes = excluded.archive_size_bytes,
      preferred_quality_json = excluded.preferred_quality_json,
      identity_confidence = excluded.identity_confidence,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    ownerId,
    need.identity.key,
    need.identity.title,
    need.identity.mediaType,
    need.scope,
    need.identity.year,
    need.identity.show,
    need.identity.season,
    need.identity.episode,
    need.archiveState,
    need.presentCount,
    need.expectedCount,
    need.observedCount,
    need.archiveQuality ? JSON.stringify(need.archiveQuality) : null,
    need.archiveSizeBytes,
    need.preferredQuality ? JSON.stringify(need.preferredQuality) : null,
    need.identityConfidence,
  );
  return archiveDb.prepare(
    "SELECT * FROM acquisition_need WHERE owner_id = ? AND identity_key = ? AND scope = ?",
  ).get(ownerId, need.identity.key, need.scope) as NeedRow;
}

function recomputeNeedState(need: MediaNeed, candidates: SourceOption[]) {
  const betterCandidate = candidates.find((candidate) =>
    candidate.availability.state === "available"
    && qualityRank(candidate.quality) > qualityRank(need.archiveQuality),
  );
  return determineMediaNeedState({
    identityConfidence: need.identityConfidence,
    presentCount: need.presentCount,
    expectedCount: need.expectedCount,
    observedCount: need.observedCount,
    archiveQuality: need.archiveQuality,
    preferredQuality: betterCandidate?.quality ?? need.preferredQuality,
  });
}

function findingResponse(row: Record<string, unknown>, need: NeedRow, sources: SourceOption[]) {
  return {
    id: Number(row.id),
    need: {
      identity: {
        key: need.identity_key,
        title: need.title,
        mediaType: need.media_type,
        year: need.year,
        show: need.show_identity,
        season: need.season_number,
        episode: need.episode_number,
        confidence: need.identity_confidence,
      },
      scope: need.scope,
      archiveState: need.archive_state,
      presentCount: need.present_count,
      expectedCount: need.expected_count,
      observedCount: need.observed_count,
      archiveQuality: quality(need.archive_quality_json),
      archiveSizeBytes: need.archive_size_bytes,
      preferredQuality: quality(need.preferred_quality_json),
    },
    recommendation: {
      status: row.recommendation_status as AcquisitionFindingStatus,
      priority: row.priority as AcquisitionPriority,
      reason: String(row.reason),
      candidateSources: sources,
      expectedQuality: quality(row.expected_quality_json as string | null),
      expectedStorageImpact: parseJson(row.storage_impact_json as string, storageImpact(null, { freeBytes: null, status: "unavailable" })),
      confidence: Number(row.confidence ?? 0),
      blockingReasons: parseJson<string[]>(row.blocking_reasons_json as string, []),
      archiveState: row.archive_state as MediaNeed["archiveState"],
    },
    review: {
      status: row.review_status as ReviewState,
      note: (row.review_note as string | null) ?? null,
      updatedAt: (row.updated_at as string | null) ?? null,
    },
    computedAt: String(row.computed_at),
  };
}

export function upsertAcquisitionCandidate(ownerId: string, input: AcquisitionCandidateInput) {
  const sourceKey = input.sourceKey?.trim() || `${input.provider}:${input.discoveredId ?? input.title}:${input.identityKey}`;
  archiveDb.prepare(`
    INSERT INTO acquisition_source_option
      (owner_id, identity_key, title, media_type, scope, season_number, episode_number,
       provider, source_key, discovered_id, quality_json, estimated_size_bytes,
       availability_state, source_confidence, checked_at, candidate_confidence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(owner_id, source_key) DO UPDATE SET
      identity_key = excluded.identity_key,
      title = excluded.title,
      media_type = excluded.media_type,
      scope = excluded.scope,
      season_number = excluded.season_number,
      episode_number = excluded.episode_number,
      provider = excluded.provider,
      discovered_id = excluded.discovered_id,
      quality_json = excluded.quality_json,
      estimated_size_bytes = excluded.estimated_size_bytes,
      availability_state = excluded.availability_state,
      source_confidence = excluded.source_confidence,
      checked_at = excluded.checked_at,
      candidate_confidence = excluded.candidate_confidence,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    ownerId,
    input.identityKey,
    input.title,
    input.mediaType,
    input.scope,
    input.season ?? null,
    input.episode ?? null,
    input.provider,
    sourceKey,
    input.discoveredId ?? null,
    input.quality ? JSON.stringify(input.quality) : null,
    input.estimatedSizeBytes ?? null,
    input.availabilityState,
    clamp(input.sourceConfidence),
    input.checkedAt ?? new Date().toISOString(),
    clamp(input.confidence),
  );
  const candidate = sourceRows(ownerId).find((row) => row.sourceKey === sourceKey);
  return candidate ? sourceFromRow(candidate) : null;
}

function writeFinding(ownerId: string, need: NeedRow, recommendation: AcquisitionRecommendation, sources: SourceOption[], computedAt: string) {
  archiveDb.prepare(`
    INSERT INTO acquisition_finding
      (owner_id, need_id, recommendation_status, priority, archive_state, reason,
       candidate_ids_json, expected_quality_json, storage_impact_json, confidence,
       blocking_reasons_json, computed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(owner_id, need_id) DO UPDATE SET
      recommendation_status = excluded.recommendation_status,
      priority = excluded.priority,
      archive_state = excluded.archive_state,
      reason = excluded.reason,
      candidate_ids_json = excluded.candidate_ids_json,
      expected_quality_json = excluded.expected_quality_json,
      storage_impact_json = excluded.storage_impact_json,
      confidence = excluded.confidence,
      blocking_reasons_json = excluded.blocking_reasons_json,
      computed_at = excluded.computed_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    ownerId,
    need.id,
    recommendation.status,
    recommendation.priority,
    recommendation.archiveState,
    recommendation.reason,
    JSON.stringify(sources.map((source) => source.id)),
    recommendation.expectedQuality ? JSON.stringify(recommendation.expectedQuality) : null,
    JSON.stringify(recommendation.expectedStorageImpact),
    recommendation.confidence,
    JSON.stringify(recommendation.blockingReasons),
    computedAt,
  );
}

export function refreshAcquisitionIntelligence(ownerId: string) {
  const normalizedStates = readNormalizedMediaStates(ownerId);
  const persistedCandidates = sourceRows(ownerId);
  const needs = new Map<string, { need: MediaNeed; row: NeedRow }>();
  const allCandidateIdentities = new Set(persistedCandidates.map((candidate) => `${candidate.identityKey}:${candidate.scope}`));

  for (const state of normalizedStates) {
    const baseNeed = normalizedNeed(state);
    const matchingCandidates = persistedCandidates
      .filter((candidate) => candidate.identityKey === baseNeed.identity.key && candidate.scope === baseNeed.scope)
      .map(sourceFromRow);
    const need: MediaNeed = { ...baseNeed, archiveState: recomputeNeedState(baseNeed, matchingCandidates) };
    const row = updateNeed(ownerId, need);
    needs.set(`${need.identity.key}:${need.scope}`, { need, row });
    allCandidateIdentities.delete(`${need.identity.key}:${need.scope}`);
  }

  for (const candidate of persistedCandidates) {
    const key = `${candidate.identityKey}:${candidate.scope}`;
    if (!allCandidateIdentities.has(key) || needs.has(key)) continue;
    const need = candidateOnlyNeed(candidate);
    const row = updateNeed(ownerId, need);
    needs.set(key, { need, row });
  }

  const computedAt = new Date().toISOString();
  let recommendedCount = 0;
  for (const { need, row } of needs.values()) {
    archiveDb.prepare("UPDATE acquisition_source_option SET need_id = ? WHERE owner_id = ? AND identity_key = ? AND scope = ?")
      .run(row.id, ownerId, need.identity.key, need.scope);
    const sources = persistedCandidates
      .filter((candidate) => candidate.identityKey === need.identity.key && candidate.scope === need.scope)
      .map(sourceFromRow);
    const recommendation = recommendAcquisition(need, sources, storageFor(need.identity.mediaType));
    if (recommendation.status === "recommended") recommendedCount += 1;
    writeFinding(ownerId, row, recommendation, sources, computedAt);
  }

  const findingsCount = archiveDb.prepare("SELECT COUNT(*) AS count FROM acquisition_finding WHERE owner_id = ?").get(ownerId) as { count: number };
  return {
    computedAt,
    findingCount: Number(findingsCount.count),
    recommendedCount,
    blockedCount: Number(findingsCount.count) - recommendedCount,
  };
}

function readFindingRows(ownerId: string, id?: number) {
  const query = id === undefined
    ? "SELECT f.*, n.* FROM acquisition_finding f JOIN acquisition_need n ON n.id = f.need_id AND n.owner_id = f.owner_id WHERE f.owner_id = ?"
    : "SELECT f.*, n.* FROM acquisition_finding f JOIN acquisition_need n ON n.id = f.need_id AND n.owner_id = f.owner_id WHERE f.owner_id = ? AND f.id = ?";
  return (id === undefined
    ? archiveDb.prepare(query).all(ownerId)
    : archiveDb.prepare(query).all(ownerId, id)) as Array<Record<string, unknown>>;
}

export function listAcquisitionFindings(ownerId: string, filters: {
  mediaType?: string;
  status?: string;
  priority?: string;
  reviewStatus?: string;
  page?: number;
  pageSize?: number;
} = {}) {
  const rows = readFindingRows(ownerId).filter((row) =>
    (!filters.mediaType || row.media_type === filters.mediaType)
    && (!filters.status || row.recommendation_status === filters.status)
    && (!filters.priority || row.priority === filters.priority)
    && (!filters.reviewStatus || row.review_status === filters.reviewStatus),
  );
  const pageSize = Math.max(1, Math.min(500, Math.trunc(filters.pageSize ?? 100)));
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const sources = sourceRows(ownerId);
  const results = rows.slice((page - 1) * pageSize, page * pageSize).map((row) => {
    const ids = new Set(parseJson<Array<number | string>>(row.candidate_ids_json as string, []));
    return findingResponse(row, row as unknown as NeedRow, sources.filter((source) => ids.has(source.id)).map(sourceFromRow));
  });
  return {
    results,
    pagination: { page, pageSize, total: rows.length, totalPages: Math.ceil(rows.length / pageSize) },
    summary: {
      total: rows.length,
      recommended: rows.filter((row) => row.recommendation_status === "recommended").length,
      blocked: rows.filter((row) => row.recommendation_status !== "recommended").length,
      highPriority: rows.filter((row) => row.priority === "high").length,
    },
  };
}

export function getAcquisitionFinding(ownerId: string, id: number) {
  const row = readFindingRows(ownerId, id)[0];
  if (!row) return null;
  const sources = sourceRows(ownerId);
  const ids = new Set(parseJson<Array<number | string>>(row.candidate_ids_json as string, []));
  return findingResponse(row, row as unknown as NeedRow, sources.filter((source) => ids.has(source.id)).map(sourceFromRow));
}

export function updateAcquisitionFindingReview(ownerId: string, id: number, status: ReviewState, note: string | null) {
  const result = archiveDb.prepare(`
    UPDATE acquisition_finding
    SET review_status = ?, review_note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE owner_id = ? AND id = ?
  `).run(status, note, ownerId, id);
  if (!result.changes) return null;
  return getAcquisitionFinding(ownerId, id);
}

export function acquisitionConfidenceExample(input: Parameters<typeof calculateConfidence>[0]) {
  return calculateConfidence(input);
}
