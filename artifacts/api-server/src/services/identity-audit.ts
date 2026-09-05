import { setImmediate } from "node:timers/promises";
import { archiveDb } from "../lib/archive-db";
import { localEpisodeIdentity, normalizeTitle, titleYear } from "./archive";

export type IdentityAuditType =
  | "suspicious_year"
  | "numeric_title"
  | "collection_prefix"
  | "missing_year"
  | "year_conflict"
  | "title_conflict"
  | "multiple_candidates"
  | "unresolved";

type LocalRow = {
  id: number;
  path: string;
  relative_path: string;
  filename: string;
  media_type: string | null;
  local_identity_id: number | null;
  identity_key: string | null;
  normalized_title: string | null;
  identity_year: number | null;
  show_identity: string | null;
  season_number: number | null;
  episode_number: number | null;
};

type PlexRow = {
  rating_key: string;
  title: string;
  item_type: string;
  year: number | null;
};

type Candidate = {
  title: string;
  normalizedTitle: string;
  year: number | null;
  ratingKey: string;
  itemType: string;
};

type EvidenceRole = "filename" | "media_folder" | "collection_folder" | "processing_folder" | "contextual_folder";

type AuditCandidate = {
  fileRecordId: number;
  path: string;
  currentLocalIdentity: Record<string, unknown> | null;
  extractedCandidates: Array<{ title: string; normalizedTitle: string; year: number | null; source: string }>;
  plexCandidates: Candidate[];
  reason: string;
  auditType: IdentityAuditType;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  recommendedInterpretation: string;
  needsReview: boolean;
  mediaType: string | null;
};

function readLocalRows(ownerId: string) {
  return archiveDb.prepare(`
    SELECT f.id, f.path, f.relative_path, f.filename, f.media_type, f.local_identity_id,
           i.identity_key, i.normalized_title, i.year AS identity_year,
           i.show_identity, i.season_number, i.episode_number
    FROM file_record f
    LEFT JOIN local_media_identity i ON i.id = f.local_identity_id AND i.owner_id = f.owner_id
    WHERE f.owner_id = ?
    ORDER BY f.id
  `).all(ownerId) as LocalRow[];
}

function readPlexRows(ownerId: string) {
  return archiveDb.prepare(`
    SELECT rating_key, title, item_type, year
    FROM plex_item
    WHERE owner_id = ?
    ORDER BY id
  `).all(ownerId) as PlexRow[];
}

function add(index: Map<string, PlexRow[]>, key: string, row: PlexRow) {
  const rows = index.get(key) ?? [];
  rows.push(row);
  index.set(key, rows);
}

function yearCandidates(value: string) {
  return [...value.matchAll(/\b((?:19|20)\d{2})\b/g)].map((match) => Number(match[1]));
}

function isNumericTitle(value: string) {
  return /^\d+(?:\s|$)/.test(normalizeTitle(value));
}

function collectionPrefix(value: string) {
  return /(?:^|[\\/])(?:\[[^\]]+\]|(?:19|20)\d{2}\s*[-_])/i.test(value)
    || /(?:^|[\\/])\d+\s*[-_.]\s*[^\\/]+[\\/]/.test(value);
}

function directoryRole(value: string): Exclude<EvidenceRole, "filename"> {
  const normalized = value.replace(/\//g, "\\");
  const segments = normalized.split("\\").filter(Boolean);
  const names = segments.map((segment) => segment.toLowerCase());
  const joined = names.join(" ");
  const technicalPattern = /\b(?:yify|bone|mkvking|ozlem|aac|ac3|bluray|web[ ._-]?dl|x26[45]|h26[45]|hevc|av1|720p|1080p|2160p|4k|uhd)\b/i;
  const processingPattern = /^(?:plex versions?|optimized for tv|season(?:\s+\d+)?|specials?|extras?|bonus|processed|converted|transcoded)$/i;
  const collectionPattern = /\b(?:collection|complete set|box set|boxset|filmography)\b/i.test(joined)
    || /\b(?:movies?|films?)\s+\d+\s*[-&]\s*\d+\b/i.test(joined)
    || /\b(?:19|20)\d{2}\s*[-_]\s*(?:19|20)?\d{2}\b/i.test(joined)
    || /^\[[^\]]+\]/.test(segments.at(-1) ?? "");
  if (names.some((name) => processingPattern.test(name)) || /plex versions|optimized for tv/i.test(joined)) {
    return "processing_folder";
  }
  if (names.some((name) => technicalPattern.test(name))) return "contextual_folder";
  if (collectionPattern || collectionPrefix(value)) return "collection_folder";
  const last = segments.at(-1) ?? "";
  return last ? "media_folder" : "contextual_folder";
}

function canProvideTitleEvidence(source: EvidenceRole) {
  return source === "filename" || source === "media_folder";
}

function localIdentity(row: LocalRow) {
  if (!row.local_identity_id && !row.normalized_title && !row.show_identity) return null;
  return {
    id: row.local_identity_id,
    identityKey: row.identity_key,
    title: row.normalized_title,
    year: row.identity_year,
    show: row.show_identity,
    season: row.season_number,
    episode: row.episode_number,
  };
}

function extractedCandidates(row: LocalRow) {
  const parsedEpisode = localEpisodeIdentity(row.filename);
  const extractedYear = titleYear(row.filename);
  const normalizedTitle = parsedEpisode?.show ?? normalizeTitle(row.filename);
  const values = [{
    title: parsedEpisode?.show ?? row.filename.replace(/\.[^.]+$/, ""),
    normalizedTitle,
    year: parsedEpisode ? null : extractedYear,
    source: "filename" as EvidenceRole,
  }];
  if (row.relative_path !== row.filename) {
    const directoryTitle = row.relative_path.replace(/[\\/][^\\/]+$/, "");
    const directoryNormalized = normalizeTitle(directoryTitle);
    if (directoryNormalized && directoryNormalized !== normalizedTitle) {
      values.push({
        title: directoryTitle,
        normalizedTitle: directoryNormalized,
        year: extractedYear,
        source: directoryRole(directoryTitle),
      });
    }
  }
  return values;
}

function candidateRows(row: LocalRow, extracted: ReturnType<typeof extractedCandidates>, byTitle: Map<string, PlexRow[]>, byTitleYear: Map<string, PlexRow[]>) {
  const candidates: PlexRow[] = [];
  for (const extractedTitle of extracted.filter((value) => canProvideTitleEvidence(value.source))) {
    const exact = extractedTitle.year === null ? [] : byTitleYear.get(`${extractedTitle.normalizedTitle}:${extractedTitle.year}`) ?? [];
    const titleOnly = byTitle.get(extractedTitle.normalizedTitle) ?? [];
    for (const candidate of [...exact, ...titleOnly]) {
      if (!candidates.some((value) => value.rating_key === candidate.rating_key)) candidates.push(candidate);
    }
  }
  const isTv = /(^|[\\/])tv shows?([\\/]|$)/i.test(row.path.replace(/\\/g, "/"));
  const typedCandidates = isTv
    ? candidates.filter((candidate) => candidate.item_type === "episode")
    : candidates.filter((candidate) => candidate.item_type === "movie");
  if (isTv) return typedCandidates;
  const localYear = row.identity_year ?? titleYear(row.filename);
  if (localYear === null) return typedCandidates;
  const sameYear = typedCandidates.filter((candidate) => candidate.year === localYear);
  return sameYear.length > 0 ? sameYear : typedCandidates;
}

function authoritativeCandidates(
  row: LocalRow,
  extracted: ReturnType<typeof extractedCandidates>,
  candidates: PlexRow[],
) {
  const isTv = /(^|[\\/])tv shows?([\\/]|$)/i.test(row.path.replace(/\\/g, "/"));
  if (isTv) return candidates;
  const exactExtracted = candidates.filter((candidate) => extracted.some((value) =>
    value.year !== null
    && normalizeTitle(candidate.title) === value.normalizedTitle
    && candidate.year === value.year));
  if (exactExtracted.length > 0) return exactExtracted;
  const knownYear = row.identity_year;
  if (knownYear === null) return candidates;
  const exactKnownYear = candidates.filter((candidate) => candidate.year === knownYear);
  return exactKnownYear.length > 0 ? exactKnownYear : candidates;
}

function auditRow(row: LocalRow, plexByTitle: Map<string, PlexRow[]>, plexByTitleYear: Map<string, PlexRow[]>) {
  const extracted = extractedCandidates(row);
  const allCandidates = candidateRows(row, extracted, plexByTitle, plexByTitleYear);
  const candidates = authoritativeCandidates(row, extracted, allCandidates);
  const localYear = row.identity_year ?? titleYear(row.filename);
  const parsedYears = yearCandidates(row.filename);
  const extractedYear = extracted[0]?.year ?? null;
  const corroboratedTitleYear = candidates.length === 1
    && extractedYear !== null
    && normalizeTitle(candidates[0].title) === extracted[0]?.normalizedTitle
    && candidates[0].year === extractedYear
  const durableIdentityConflict = row.identity_year !== null
    && extractedYear !== null
    && row.identity_year !== extractedYear;
  const types: Array<{
    type: IdentityAuditType;
    reason: string;
    confidence: AuditCandidate["confidence"];
    evidence: string[];
    recommendation: string;
    needsReview: boolean;
  }> = [];
  const addType = (
    type: IdentityAuditType,
    reason: string,
    confidence: AuditCandidate["confidence"],
    evidence: string[],
    recommendation: string,
    needsReview = true,
  ) => {
    types.push({ type, reason, confidence, evidence, recommendation, needsReview });
  };

  if (!row.local_identity_id && candidates.length === 0) {
    addType("unresolved", "No durable local identity or Plex candidate could be established.", "low", ["local_identity_id is null", "no indexed Plex title candidate"], "Keep unresolved and review the filename manually.");
  }
  if (isNumericTitle(row.filename)) {
    const confirmed = corroboratedTitleYear;
    addType(
      "numeric_title",
      confirmed
        ? "The title begins with a numeric token, but Plex confirms an unambiguous title/year match."
        : "The normalized local title begins with a numeric token that may also be a title or a year.",
      confirmed ? "high" : "medium",
      [`filename: ${row.filename}`, ...(confirmed ? [`Plex confirms: ${candidates[0].title} (${candidates[0].year})`] : [])],
      confirmed
        ? "Treat the numeric token as title content; no identity review is required."
        : "Treat numeric tokens as title content unless Plex evidence confirms they are metadata.",
      !confirmed,
    );
  }
  if (collectionPrefix(row.path) || collectionPrefix(row.relative_path)) {
    addType("collection_prefix", "A collection or numbered folder prefix may have been included in the local title/year.", "medium", [`path: ${row.path}`], "Use the media title inside the collection prefix as the likely identity.");
  }
  if (localYear === null && candidates.length > 0) {
    addType("missing_year", "A Plex title candidate exists, but the local filename and identity have no year.", "medium", ["local year is missing", `Plex candidates: ${candidates.length}`], "Use title evidence only and require review before assigning a year.");
  }
  if (!corroboratedTitleYear && (parsedYears.length > 1 || (parsedYears.length === 1 && localYear !== parsedYears[0]))) {
    addType("suspicious_year", "Multiple year-like tokens or a durable year disagree with the filename's year tokens.", "medium", [`filename years: ${parsedYears.join(", ") || "none"}`, `identity year: ${row.identity_year ?? "none"}`], "Review which year is the release year rather than a title, collection, or technical token.");
  }
  const conflicting = durableIdentityConflict
    ? candidates.filter((candidate) => candidate.year !== null && candidate.year !== localYear)
    : [];
  if (conflicting.length > 0) {
    addType("year_conflict", "An indexed Plex title candidate has a different year from the local identity.", "high", [`local year: ${localYear}`, `Plex years: ${[...new Set(conflicting.map((candidate) => candidate.year))].join(", ")}`], "Do not select automatically; compare the title and release-year evidence.");
  }
  const titleConflict = row.normalized_title !== null
    && extracted.some((value) => canProvideTitleEvidence(value.source) && value.normalizedTitle !== row.normalized_title);
  if (titleConflict) {
    addType("title_conflict", "The durable identity title differs from the title extracted from the current path.", "high", [`identity title: ${row.normalized_title}`, `extracted titles: ${extracted.map((value) => value.normalizedTitle).join("; ")}`], "Review the durable identity and path-derived title before changing either.");
  }
  if (candidates.length > 1) {
    addType("multiple_candidates", "Multiple Plex rows match the indexed local title candidates.", "high", [`candidate count: ${candidates.length}`], "Preserve ambiguity and select a Plex item only through human review.");
  }
  return types.map((audit) => ({
    fileRecordId: row.id,
    path: row.path,
    currentLocalIdentity: localIdentity(row),
    extractedCandidates: extracted,
    plexCandidates: candidates.map((candidate) => ({
      title: candidate.title,
      normalizedTitle: normalizeTitle(candidate.title),
      year: candidate.year,
      ratingKey: candidate.rating_key,
      itemType: candidate.item_type,
    })),
    reason: audit.reason,
    auditType: audit.type,
    confidence: audit.confidence,
    evidence: audit.evidence,
    recommendedInterpretation: audit.recommendation,
    needsReview: audit.needsReview,
    mediaType: row.media_type,
  } satisfies AuditCandidate));
}

export async function readIdentityAudit(ownerId: string, options: {
  page?: number;
  pageSize?: number;
  auditType?: string;
  confidence?: string;
  mediaType?: string;
  needsReview?: boolean;
} = {}) {
  const plexRows = readPlexRows(ownerId);
  const plexByTitle = new Map<string, PlexRow[]>();
  const plexByTitleYear = new Map<string, PlexRow[]>();
  for (const row of plexRows) {
    const title = normalizeTitle(row.title);
    if (!title) continue;
    add(plexByTitle, title, row);
    if (row.year !== null) add(plexByTitleYear, `${title}:${row.year}`, row);
  }
  const results: AuditCandidate[] = [];
  for (const row of readLocalRows(ownerId)) {
    results.push(...auditRow(row, plexByTitle, plexByTitleYear));
    if (results.length % 500 === 0) await setImmediate();
  }
  const filtered = results.filter((result) =>
    (!options.auditType || result.auditType === options.auditType)
    && (!options.confidence || result.confidence === options.confidence)
    && (!options.mediaType || result.mediaType === options.mediaType)
    && (options.needsReview === undefined || result.needsReview === options.needsReview));
  const pageSize = Number.isInteger(options.pageSize) ? Math.max(1, Math.min(500, options.pageSize!)) : 100;
  const page = Number.isInteger(options.page) ? Math.max(1, options.page!) : 1;
  const counts = new Map<string, number>();
  const confidenceCounts = new Map<string, number>();
  for (const result of filtered) {
    counts.set(result.auditType, (counts.get(result.auditType) ?? 0) + 1);
    confidenceCounts.set(result.confidence, (confidenceCounts.get(result.confidence) ?? 0) + 1);
  }
  return {
    summary: {
      totalCandidates: filtered.length,
      byAuditType: Object.fromEntries(counts),
      byConfidence: Object.fromEntries(confidenceCounts),
    },
    pagination: {
      page,
      pageSize,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / pageSize),
    },
    results: filtered.slice((page - 1) * pageSize, page * pageSize),
  };
}
