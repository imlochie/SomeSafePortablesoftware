import { createHash } from "node:crypto";
import { archiveDb, addEvent, readSettings } from "../lib/archive-db";
import { integrationRegistry, type IntegrationStatus, type MissingMediaRecord } from "../integrations";
import { readArchiveInventory } from "./archive";
import { listAcquisitionJobs, type AcquisitionProviderId } from "./acquisition-jobs";
import { chooseArchiveVolume, getArchiveVolumes } from "./storage";
import { ensureReviewItem } from "./review-queue";

export const recommendationConfidences = ["high", "medium", "low", "unknown"] as const;
export type RecommendationConfidence = (typeof recommendationConfidences)[number];
export const recommendationPriorities = ["critical", "high", "medium", "low"] as const;
export type RecommendationPriority = (typeof recommendationPriorities)[number];

export interface AcquisitionRecommendation {
  id: number;
  recommendationKey: string;
  mediaType: string;
  title: string;
  year: number | null;
  externalId: string | null;
  target: Record<string, unknown>;
  evidence: Record<string, unknown>;
  preferredQuality: Record<string, unknown>;
  destination: Record<string, unknown>;
  route: Record<string, unknown>;
  blockers: string[];
  recommendedAction: string;
  confidence: RecommendationConfidence;
  priority: RecommendationPriority;
  status: string;
  reviewItemId: number | null;
  acquisitionJobId: number | null;
  evidenceHash: string;
  generatedAt: string;
  updatedAt: string;
}

type Candidate = {
  targetKey: string;
  mediaType: string;
  title: string;
  year: number | null;
  externalId: string | null;
  target: Record<string, unknown>;
  reason: string;
  preferredQuality: Record<string, unknown>;
  priority: RecommendationPriority;
  providerEvidence?: { providerId: AcquisitionProviderId; item: MissingMediaRecord };
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseRecord(value: unknown): Record<string, unknown> {
  try {
    return record(JSON.parse(String(value ?? "{}")));
  } catch {
    return {};
  }
}

function parseStrings(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function normalizeTitle(value: string) {
  return value.toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function routeFor(mediaType: string): AcquisitionProviderId | null {
  const normalized = mediaType.toLowerCase();
  if (normalized === "movie" || normalized === "film") return "radarr";
  if (["tv", "series", "episode"].includes(normalized)) return "sonarr";
  return null;
}

function mapRecommendation(row: Record<string, unknown>): AcquisitionRecommendation {
  const blockers = parseStrings(row.blockers_json);
  return {
    id: Number(row.id),
    recommendationKey: String(row.recommendation_key),
    mediaType: String(row.media_type),
    title: String(row.title),
    year: row.year == null ? null : Number(row.year),
    externalId: row.external_id == null ? null : String(row.external_id),
    target: parseRecord(row.target_json),
    evidence: parseRecord(row.evidence_json),
    preferredQuality: parseRecord(row.quality_json),
    destination: parseRecord(row.destination_json),
    route: parseRecord(row.route_json),
    blockers,
    recommendedAction: blockers.length
      ? "Resolve the listed blockers, regenerate evidence, then review again."
      : row.acquisition_job_id == null
        ? "Approve this review item to enable acquisition job creation."
        : "Track the linked acquisition through download verification and approved import.",
    confidence: String(row.confidence) as RecommendationConfidence,
    priority: String(row.priority) as RecommendationPriority,
    status: String(row.status),
    reviewItemId: row.review_item_id == null ? null : Number(row.review_item_id),
    acquisitionJobId: row.acquisition_job_id == null ? null : Number(row.acquisition_job_id),
    evidenceHash: String(row.evidence_hash),
    generatedAt: String(row.generated_at),
    updatedAt: String(row.updated_at),
  };
}

export function readAcquisitionRecommendation(id: number, ownerId: string) {
  const row = archiveDb.prepare(
    "SELECT * FROM acquisition_recommendation WHERE id = ? AND owner_id = ?",
  ).get(id, ownerId) as Record<string, unknown> | undefined;
  return row ? mapRecommendation(row) : null;
}

export function listAcquisitionRecommendations(
  ownerId: string,
  filters: { status?: string; priority?: RecommendationPriority; blocked?: boolean } = {},
) {
  const conditions = ["owner_id = ?"];
  const values: Array<string> = [ownerId];
  if (filters.status) {
    conditions.push("status = ?");
    values.push(filters.status);
  }
  if (filters.priority) {
    conditions.push("priority = ?");
    values.push(filters.priority);
  }
  const rows = archiveDb.prepare(`
    SELECT * FROM acquisition_recommendation
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      updated_at DESC, id DESC
  `).all(...values) as Array<Record<string, unknown>>;
  const recommendations = rows.map(mapRecommendation);
  return filters.blocked === undefined
    ? recommendations
    : recommendations.filter((item) => (item.blockers.length > 0) === filters.blocked);
}

async function providerMissing(ownerId: string, statuses: IntegrationStatus[]) {
  const results: Array<{ providerId: AcquisitionProviderId; item: MissingMediaRecord }> = [];
  const errors: Record<string, string> = {};
  for (const providerId of ["sonarr", "radarr"] as const) {
    const status = statuses.find((candidate) => candidate.id === providerId);
    if (!status?.operational || !status.capabilities.includes("missing_media_discovery")) {
      errors[providerId] = status?.detail ?? `${providerId} is unavailable.`;
      continue;
    }
    try {
      const result = await integrationRegistry.invoke(
        "missing_media_discovery",
        {},
        { ownerId },
        providerId,
      );
      for (const item of result.items) results.push({ providerId, item });
    } catch (error) {
      errors[providerId] = error instanceof Error ? error.message : `${providerId} lookup failed.`;
    }
  }
  return { results, errors };
}

function candidatesFromInventory(ownerId: string): Candidate[] {
  const inventory = readArchiveInventory(ownerId);
  const values: Candidate[] = inventory.plexOnly.map((item) => ({
    targetKey: `plex:${item.ratingKey}`,
    mediaType: item.itemType,
    title: item.title,
    year: item.year,
    externalId: null,
    target: { kind: "plex_only", ratingKey: item.ratingKey },
    reason: item.qualitySummary,
    preferredQuality: { intent: "archive_equivalent", basis: "Plex item has no matching local file." },
    priority: "high",
  }));
  for (const item of inventory.records) {
    if (!["file_missing", "lower_quality_version", "needs_review"].includes(item.qualityStatus)) continue;
    values.push({
      targetKey: `archive:${item.id}:${item.qualityStatus}`,
      mediaType: item.mediaType ?? "unknown",
      title: item.filename.replace(/\.[^.]+$/, ""),
      year: null,
      externalId: null,
      target: {
        kind: "archive_finding",
        archiveRecordId: item.id,
        qualityStatus: item.qualityStatus,
        path: item.path,
      },
      reason: item.qualitySummary,
      preferredQuality: {
        intent: item.qualityStatus === "file_missing" ? "replace_missing" : "improve_or_resolve",
        current: {
          width: item.width,
          height: item.height,
          videoCodec: item.videoCodec,
          audioCodec: item.audioCodec,
          bitrate: item.bitrate,
          dynamicRange: item.dynamicRange,
        },
        differences: item.qualityDifferences,
      },
      priority: item.qualityStatus === "file_missing" ? "critical" : "medium",
    });
  }
  return values;
}

function upsertRecommendation(
  ownerId: string,
  candidate: Candidate,
  context: {
    statuses: IntegrationStatus[];
    providerErrors: Record<string, string>;
  },
) {
  const providerId = candidate.providerEvidence?.providerId ?? routeFor(candidate.mediaType);
  const providerStatus = providerId
    ? context.statuses.find((item) => item.id === providerId) ?? null
    : null;
  const destinationType = ["tv", "series", "episode"].includes(candidate.mediaType.toLowerCase())
    ? "tv"
    : "movie";
  const settings = readSettings();
  const destination = chooseArchiveVolume(settings, destinationType);
  const activeJob = listAcquisitionJobs(ownerId).find((job) =>
    !["failed", "cancelled"].includes(job.state)
    && (
      (candidate.externalId && job.externalId === candidate.externalId)
      || (normalizeTitle(job.title) === normalizeTitle(candidate.title) && job.year === candidate.year)
    ));
  const blockers: string[] = [];
  if (!providerId) blockers.push("No acquisition route supports this media type.");
  else if (!providerStatus?.operational) {
    blockers.push(context.providerErrors[providerId] ?? `${providerId} is not operational.`);
  }
  if (!destination) blockers.push("No writable archive destination is available for this media type.");
  if (!candidate.providerEvidence) {
    blockers.push("Release/source availability has not been confirmed by an operational provider.");
  }
  if (activeJob) blockers.push(`Acquisition job ${activeJob.id} already tracks this target.`);

  const evidence = {
    reason: candidate.reason,
    archive: candidate.target,
    provider: candidate.providerEvidence
      ? {
          providerId: candidate.providerEvidence.providerId,
          reportedMissing: true,
          detail: candidate.providerEvidence.item.detail ?? null,
        }
      : {
          providerId,
          availability: "unknown",
          status: providerStatus?.state ?? "unavailable",
          detail: providerStatus?.detail ?? null,
        },
    existingAcquisitionJobId: activeJob?.id ?? null,
    generatedFromCurrentState: true,
  };
  const destinationEvidence = destination
    ? {
        id: destination.id,
        path: destination.path,
        writable: destination.writable,
        exists: destination.exists,
        freeBytes: destination.freeBytes,
      }
    : {
        available: false,
        candidates: getArchiveVolumes(settings)
          .filter((item) => item.mediaType === destinationType)
          .map((item) => ({
            id: item.id,
            path: item.path,
            exists: item.exists,
            writable: item.writable,
            freeBytes: item.freeBytes,
          })),
      };
  const route = {
    providerId,
    capability: "acquisition_job_creation",
    operational: providerStatus?.operational ?? false,
    execution: "approval_required",
  };
  const evidenceHash = hash({
    target: candidate.target,
    evidence,
    quality: candidate.preferredQuality,
    destination: destinationEvidence,
    route,
    blockers: [...blockers].sort(),
  });
  const recommendationKey = candidate.targetKey;
  const existing = archiveDb.prepare(`
    SELECT * FROM acquisition_recommendation
    WHERE owner_id = ? AND recommendation_key = ? AND evidence_hash = ?
  `).get(ownerId, recommendationKey, evidenceHash) as Record<string, unknown> | undefined;
  if (existing) return mapRecommendation(existing);

  archiveDb.prepare(`
    UPDATE acquisition_recommendation
    SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
    WHERE owner_id = ? AND recommendation_key = ? AND status = 'active'
  `).run(ownerId, recommendationKey);
  const result = archiveDb.prepare(`
    INSERT INTO acquisition_recommendation
      (owner_id, recommendation_key, media_type, title, year, external_id,
       target_json, evidence_json, quality_json, destination_json, route_json,
       blockers_json, confidence, priority, status, acquisition_job_id, evidence_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    ownerId,
    recommendationKey,
    candidate.mediaType,
    candidate.title,
    candidate.year,
    candidate.externalId,
    JSON.stringify(candidate.target),
    JSON.stringify(evidence),
    JSON.stringify(candidate.preferredQuality),
    JSON.stringify(destinationEvidence),
    JSON.stringify(route),
    JSON.stringify(blockers),
    candidate.providerEvidence && destination && blockers.length <= 1 ? "medium" : "unknown",
    candidate.priority,
    activeJob?.id ?? null,
    evidenceHash,
  );
  const id = Number(result.lastInsertRowid);
  const review = ensureReviewItem(ownerId, {
    kind: "acquisition_recommendation",
    subjectKey: `acquisition-recommendation:${id}`,
    title: `Acquire ${candidate.title}`,
    payload: {
      recommendationId: id,
      mediaType: candidate.mediaType,
      title: candidate.title,
      year: candidate.year,
      externalId: candidate.externalId,
      route,
      destination: destinationEvidence,
      blockers,
    },
  });
  archiveDb.prepare(`
    UPDATE acquisition_recommendation
    SET review_item_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_id = ?
  `).run(review.id, id, ownerId);
  return readAcquisitionRecommendation(id, ownerId)!;
}

export async function generateAcquisitionRecommendations(ownerId: string) {
  const statuses = await integrationRegistry.getStatuses(ownerId);
  const missing = await providerMissing(ownerId, statuses);
  const candidates = candidatesFromInventory(ownerId);
  const seen = new Set(candidates.map((item) => item.targetKey));
  for (const value of missing.results) {
    const key = `provider:${value.providerId}:${value.item.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      targetKey: key,
      mediaType: value.item.mediaType,
      title: value.item.title,
      year: value.item.year,
      externalId: value.item.externalId,
      target: {
        kind: "provider_missing",
        providerId: value.providerId,
        externalId: value.item.externalId,
      },
      reason: value.item.detail ?? `${value.providerId} reports this media as missing.`,
      preferredQuality: {
        intent: "provider_profile",
        basis: "Use the configured provider quality profile; no source quality has been invented.",
      },
      priority: "high",
      providerEvidence: value,
    });
  }
  const recommendations = candidates.map((candidate) =>
    upsertRecommendation(ownerId, candidate, {
      statuses,
      providerErrors: missing.errors,
    }));
  addEvent(
    "info",
    `Acquisition intelligence evaluated ${candidates.length} targets and retained ${recommendations.length} current recommendations.`,
    "acquisition-intelligence",
    ownerId,
  );
  return recommendations;
}

export function linkRecommendationToAcquisitionJob(
  recommendationId: number,
  jobId: number,
  ownerId: string,
) {
  const recommendation = readAcquisitionRecommendation(recommendationId, ownerId);
  if (!recommendation) throw new Error("Acquisition recommendation not found.");
  archiveDb.prepare(`
    UPDATE acquisition_recommendation
    SET acquisition_job_id = ?, status = 'accepted', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND owner_id = ?
  `).run(jobId, recommendationId, ownerId);
  return readAcquisitionRecommendation(recommendationId, ownerId)!;
}