import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { archiveDb, readSettings, type SettingsRecord } from "../lib/archive-db";
import { getArchiveVolumes, isArchivePathWithin } from "./storage";
import { localEpisodeIdentity, normalizeTitle, titleYear } from "./archive";

export type NamingConfidence = "high" | "medium" | "low" | "uncertain";
export type ProposalOperation = "rename" | "restructure" | "move" | "uncertain/no_action";
export const PROPOSAL_DECISION_STATUSES = ["accepted", "rejected", "deferred"] as const;
export type ProposalDecisionStatus = (typeof PROPOSAL_DECISION_STATUSES)[number];

type LocalRow = {
  id: number;
  local_identity_id: number | null;
  path: string;
  relative_path: string;
  filename: string;
  media_type: string | null;
  volume_id: string | null;
  archive_root: string | null;
  scan_status: string;
  size_bytes: number | null;
  modified_at_ms: number | null;
};

type Candidate = {
  show: string | null;
  season: number | null;
  episode: number | null;
  episodes: number[];
  episodeTitle: string | null;
  patternId: string;
  confidence: NamingConfidence;
  evidence: string[];
  source: "filename" | "directory" | "plex";
  multiEpisode: boolean;
  special: boolean;
  ambiguity: "resolved" | "compound" | "ambiguous" | "unresolved";
};

type Volume = {
  id: string;
  root: string;
  mediaType: "movie" | "tv";
};

type PlexEpisode = {
  ratingKey: string;
  title: string;
  show: string;
  season: number;
  episode: number;
  showRatingKey: string | null;
};

// The operator's canonical Windows volumes stay as an always-available map,
// but any volume configured through System Settings participates as well so
// naming intelligence reflects the real archive layout on every platform.
const canonicalVolumes: Volume[] = [
  { id: "d-movies", root: "D:\\Movies", mediaType: "movie" },
  { id: "d-tv", root: "D:\\Tv Shows", mediaType: "tv" },
  { id: "e-movies", root: "E:\\Movies", mediaType: "movie" },
  { id: "e-tv", root: "E:\\Tv Shows", mediaType: "tv" },
];

export function namingVolumes(settings: SettingsRecord = readSettings()): Volume[] {
  const configured: Volume[] = getArchiveVolumes(settings).map((volume) => ({
    id: volume.id,
    root: volume.path,
    mediaType: volume.mediaType,
  }));
  const covered = new Set(configured.map((volume) => volume.root.replace(/[\\/]+$/g, "").toLowerCase()));
  const legacy = canonicalVolumes.filter((volume) => !covered.has(volume.root.replace(/[\\/]+$/g, "").toLowerCase()));
  return [...configured, ...legacy];
}

function volumeForPath(path: string, volumes: Volume[]) {
  return volumes.find((volume) => isArchivePathWithin(path, volume.root)) ?? null;
}

// Evidence identity for durable decisions: it must change whenever the input
// or output of a proposal changes, so a decision can never follow a file to
// unrelated evidence. Mirrors the archive_review evidence-key design.
export function namingProposalEvidenceKey(input: {
  fileRecordId: number;
  sourcePath: string;
  sourceFilename: string;
  sizeBytes: number | null;
  modifiedAtMs: number | null;
  patternId: string;
  confidence: NamingConfidence;
  operation: ProposalOperation;
  proposedPath: string | null;
  collision: boolean;
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      fileRecordId: input.fileRecordId,
      sourcePath: input.sourcePath,
      sourceFilename: input.sourceFilename,
      sizeBytes: input.sizeBytes,
      modifiedAtMs: input.modifiedAtMs,
      patternId: input.patternId,
      confidence: input.confidence,
      operation: input.operation,
      proposedPath: input.proposedPath,
      collision: input.collision,
    }))
    .digest("hex");
}

function cleanShow(value: string) {
  return normalizeTitle(value.replace(/\bS\d{1,2}(?:[- ]S?\d{1,2})?\b/gi, ""));
}

function directoryContext(row: LocalRow, volume: Volume) {
  const rel = relative(volume.root, row.path).replaceAll("/", "\\");
  const parts = rel.split("\\").filter(Boolean);
  const filename = parts.pop() ?? row.filename;
  const directories = parts;
  const seasonIndex = directories.findIndex((part) => /^season[ ._-]*\d{1,2}$/i.test(part));
  const season = seasonIndex >= 0
    ? Number(directories[seasonIndex].match(/\d{1,2}/)?.[0])
    : null;
  const showDirectory = seasonIndex >= 0
    ? directories[seasonIndex - 1] ?? null
    : directories.at(-1) ?? null;
  return { filename, directories, season, showDirectory: showDirectory ? cleanShow(showDirectory) : null };
}

function episodeNumberFilename(filename: string) {
  const stem = filename.replace(/\.[^.]+$/, "");
  const match = stem.match(/^(?:episode[ ._-]*)?(\d{1,3})(?:\s*[-_.]\s*|\s+)(.+)$/i);
  if (!match || Number(match[1]) > 99) return null;
  const title = normalizeTitle(match[2]);
  return { episode: Number(match[1]), title: title || null };
}

function multiEpisode(filename: string) {
  const stem = filename.replace(/\.[^.]+$/, "");
  return /S\d{1,2}E\d{1,2}(?:[A-Z]|\s*(?:\+|E)\s*\d{1,2})/i.test(stem)
    || /\b\d{1,2}x\d{1,2}(?:[-+]\d{1,2})+\b/i.test(stem);
}

function structuredCandidate(filename: string) {
  const stem = filename.replace(/\.[^.]+$/, "");
  const match = stem.match(/^(.+?)[\s._-]+S(\d{1,2})[\s._-]*E(\d{1,2})(.*)$/i);
  if (match) {
    const additional = [...match[4].matchAll(/(?:E|\+)\s*E?\s*(\d{1,2})/gi)].map((value) => Number(value[1]));
    return {
      show: normalizeTitle(match[1]),
      season: Number(match[2]),
      episodes: [Number(match[3]), ...additional],
    };
  }
  const numbered = stem.match(/^(.+?)[\s._-]+(\d{1,2})x(\d{1,2})(.*)$/i);
  if (!numbered) return null;
  const additional = [...numbered[4].matchAll(/(?:x|\+)\s*(\d{1,2})/gi)].map((value) => Number(value[1]));
  return {
    show: normalizeTitle(numbered[1]),
    season: Number(numbered[2]),
    episodes: [Number(numbered[3]), ...additional],
  };
}

function parseCandidate(row: LocalRow, volume: Volume): Candidate | null {
  const context = directoryContext(row, volume);
  const structured = structuredCandidate(context.filename);
  const parsed = localEpisodeIdentity(context.filename);
  const isMulti = multiEpisode(context.filename);
  if (structured || parsed) {
    const show = structured?.show ?? parsed?.show ?? null;
    const season = structured?.season ?? parsed?.season ?? null;
    const episodes = structured?.episodes ?? (parsed ? [parsed.episode] : []);
    return {
      show,
      season,
      episode: episodes.length === 1 ? episodes[0] : null,
      episodes,
      episodeTitle: null,
      patternId: isMulti ? "structured_multi_episode" : "structured_sxxexx",
      confidence: isMulti ? "low" : "high",
      evidence: ["filename contains a supported season/episode marker"],
      source: "filename",
      multiEpisode: isMulti,
      special: false,
      ambiguity: isMulti ? "compound" : "resolved",
    };
  }

  const numbered = episodeNumberFilename(context.filename);
  const special = /\b(?:special|ova|oav|movie|film|bonus|pilot|extra|christmas|halloween)\b/i.test(context.filename);
  if (numbered && context.showDirectory && context.season !== null && !special) {
    return {
      show: context.showDirectory,
      season: context.season,
      episode: numbered.episode,
      episodes: [numbered.episode],
      episodeTitle: numbered.title,
      patternId: "directory_show_season_episode_number",
      confidence: "high",
      evidence: ["show directory", "Season N directory", "leading episode number"],
      source: "directory",
      multiEpisode: false,
      special: false,
      ambiguity: "resolved",
    };
  }
  if (numbered && context.showDirectory && !special) {
    return {
      show: context.showDirectory,
      season: null,
      episode: numbered.episode,
      episodes: [numbered.episode],
      episodeTitle: numbered.title,
      patternId: "directory_show_episode_number",
      confidence: "medium",
      evidence: ["show directory", "leading episode number", "season not established"],
      source: "directory",
      multiEpisode: false,
      special: false,
      ambiguity: "unresolved",
    };
  }

  const absolute = context.filename.match(/^(?:episode[ ._-]*)?(\d{2,4})\s*(?:of|\/)\s*(\d{2,4})\b/i);
  if (absolute && context.showDirectory && !special) {
    return {
      show: context.showDirectory,
      season: null,
      episode: Number(absolute[1]),
      episodes: [Number(absolute[1])],
      episodeTitle: null,
      patternId: "directory_show_absolute_episode",
      confidence: "low",
      evidence: ["show directory", "absolute episode numbering"],
      source: "directory",
      multiEpisode: false,
      special: false,
      ambiguity: "unresolved",
    };
  }
  if (special || /(?:^|[ ._-])(?:part|disc|volume)\b/i.test(context.filename)) {
    return {
      show: context.showDirectory,
      season: context.season,
      episode: null,
      episodes: [],
      episodeTitle: null,
      patternId: "special_or_bonus",
      confidence: "low",
      evidence: ["special, bonus, disc, volume, or movie marker"],
      source: "directory",
      multiEpisode: false,
      special: true,
      ambiguity: "unresolved",
    };
  }
  return null;
}

function proposedPath(row: LocalRow, volume: Volume, candidate: Candidate) {
  if (
    volume.mediaType !== "tv"
    || !candidate.show
    || candidate.season === null
    || candidate.episode === null
    || candidate.episodes.length !== 1
    || candidate.confidence === "low"
    || candidate.multiEpisode
    || candidate.special
  ) return null;
  const extension = extname(row.filename).toLowerCase();
  const title = candidate.episodeTitle ? ` - ${candidate.episodeTitle}` : "";
  const filename = `${candidate.show} - S${String(candidate.season).padStart(2, "0")}E${String(candidate.episode).padStart(2, "0")}${title}${extension}`;
  return resolve(volume.root, candidate.show, `Season ${String(candidate.season).padStart(2, "0")}`, filename);
}

function resolveWithPlex(candidate: Candidate | null, plexByShow: Map<string, PlexEpisode[]>) {
  if (!candidate?.show || candidate.episode === null || candidate.ambiguity === "compound") return candidate;
  const matches = (plexByShow.get(candidate.show) ?? []).filter((episode) =>
    episode.episode === candidate.episode
    && (candidate.season === null || episode.season === candidate.season));
  if (matches.length !== 1) {
    return matches.length > 1
      ? { ...candidate, confidence: "uncertain" as const, ambiguity: "ambiguous" as const, evidence: [...candidate.evidence, "multiple Plex episode candidates"] }
      : candidate;
  }
  const match = matches[0];
  return {
    ...candidate,
    season: candidate.season ?? match.season,
    confidence: candidate.season === null ? "high" as const : candidate.confidence,
    ambiguity: "resolved" as const,
    evidence: [...candidate.evidence, `Plex corroboration: ${match.ratingKey}`],
  };
}

// The shared shape of every proposal record (TV and movie) as returned by the
// API and consumed by decision/apply flows. Identity payloads stay structural
// because TV and movie identities carry different fields.
export type NamingProposal = {
  fileRecordId: number;
  localIdentityId: number | null;
  sourcePath: string;
  proposedPath: string | null;
  sourceFilename: string;
  proposedFilename: string | null;
  currentIdentity: Record<string, unknown> | null;
  proposedIdentity: Record<string, unknown> | null;
  patternId: string;
  confidence: NamingConfidence;
  operation: ProposalOperation;
  reason: string;
  evidence: string[];
  mediaType: "movie" | "tv";
  volumeId: string;
  archiveRoot: string;
  collision: boolean;
  sizeBytes: number | null;
  modifiedAtMs: number | null;
  evidenceKey: string;
};

function makeProposal(row: LocalRow, volume: Volume, candidate: Candidate | null, knownPaths: Set<string>, plexByShow: Map<string, PlexEpisode[]>): NamingProposal {
  const resolvedCandidate = resolveWithPlex(candidate, plexByShow);
  const currentIdentity = localEpisodeIdentity(row.filename);
  const destination = resolvedCandidate ? proposedPath(row, volume, resolvedCandidate) : null;
  const normalizedDestination = destination?.toLowerCase() ?? null;
  const collision = Boolean(normalizedDestination && knownPaths.has(normalizedDestination) && normalizedDestination !== row.path.toLowerCase());
  const executable = Boolean(destination && !collision && resolvedCandidate?.confidence === "high");
  const operation: ProposalOperation = collision
    ? "uncertain/no_action"
    : executable && destination
      ? (dirname(destination).toLowerCase() === dirname(row.path).toLowerCase() ? "rename" : "restructure")
      : "uncertain/no_action";
  const confidence = (resolvedCandidate?.confidence ?? "uncertain") as NamingConfidence;
  const patternId = resolvedCandidate?.patternId ?? "unrecognized";
  const proposedPathValue = executable ? destination : null;
  return {
    fileRecordId: row.id,
    localIdentityId: row.local_identity_id,
    sourcePath: row.path,
    proposedPath: proposedPathValue,
    sourceFilename: row.filename,
    proposedFilename: executable && destination ? basename(destination) : null,
    currentIdentity: currentIdentity ? {
      show: currentIdentity.show,
      season: currentIdentity.season,
      episode: currentIdentity.episode,
    } : null,
    proposedIdentity: resolvedCandidate ? {
      show: resolvedCandidate.show,
      season: resolvedCandidate.season,
      episode: resolvedCandidate.episode,
      episodes: resolvedCandidate.episodes,
      episodeTitle: resolvedCandidate.episodeTitle,
      ambiguity: resolvedCandidate.ambiguity,
    } : null,
    patternId,
    confidence,
    operation,
    reason: collision ? "Proposed destination collides with a known file record." : resolvedCandidate?.evidence.join("; ") ?? "No safe naming convention recognized.",
    evidence: resolvedCandidate?.evidence ?? [],
    mediaType: volume.mediaType,
    volumeId: row.volume_id ?? volume.id,
    archiveRoot: row.archive_root ?? volume.root,
    collision,
    sizeBytes: row.size_bytes,
    modifiedAtMs: row.modified_at_ms,
    evidenceKey: namingProposalEvidenceKey({
      fileRecordId: row.id,
      sourcePath: row.path,
      sourceFilename: row.filename,
      sizeBytes: row.size_bytes,
      modifiedAtMs: row.modified_at_ms,
      patternId,
      confidence,
      operation,
      proposedPath: proposedPathValue,
      collision,
    }),
  };
}

// Movie proposals are intentionally read-only (no automatic restructuring),
// but they share the proposal shape and evidence key so decisions apply
// uniformly: accepting a movie proposal is rejected as non-executable.
function makeMovieProposal(row: LocalRow, volume: Volume): NamingProposal {
  const title = normalizeTitle(row.filename);
  const year = titleYear(row.filename);
  const confidence: NamingConfidence = title ? "high" : "uncertain";
  const patternId = title ? "movie_title_year" : "unrecognized";
  return {
    fileRecordId: row.id,
    localIdentityId: row.local_identity_id,
    sourcePath: row.path,
    proposedPath: null,
    sourceFilename: row.filename,
    proposedFilename: null,
    currentIdentity: title ? { title, year } : null,
    proposedIdentity: title ? { title, year } : null,
    patternId,
    confidence,
    operation: "uncertain/no_action",
    reason: "Movie naming is reported read-only; no automatic restructuring proposal is generated.",
    evidence: title ? ["existing movie title normalization"] : ["empty normalized movie title"],
    mediaType: volume.mediaType,
    volumeId: row.volume_id ?? volume.id,
    archiveRoot: row.archive_root ?? volume.root,
    collision: false,
    sizeBytes: row.size_bytes,
    modifiedAtMs: row.modified_at_ms,
    evidenceKey: namingProposalEvidenceKey({
      fileRecordId: row.id,
      sourcePath: row.path,
      sourceFilename: row.filename,
      sizeBytes: row.size_bytes,
      modifiedAtMs: row.modified_at_ms,
      patternId,
      confidence,
      operation: "uncertain/no_action",
      proposedPath: null,
      collision: false,
    }),
  };
}

function readRows(ownerId: string) {
  return archiveDb.prepare(`
    SELECT id, local_identity_id, path, relative_path, filename, media_type,
           volume_id, archive_root, scan_status, size_bytes, modified_at_ms
    FROM file_record
    WHERE owner_id = ?
      AND scan_status = 'active'
    ORDER BY id
  `).all(ownerId) as LocalRow[];
}

function readPlexEpisodes(ownerId: string) {
  const rows = archiveDb.prepare(`
    SELECT rating_key, title, metadata_json
    FROM plex_item
    WHERE owner_id = ? AND item_type = 'episode'
  `).all(ownerId) as Array<{ rating_key: string; title: string; metadata_json: string }>;
  const index = new Map<string, PlexEpisode[]>();
  for (const row of rows) {
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.metadata_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const show = typeof data.grandparentTitle === "string" ? normalizeTitle(data.grandparentTitle) : "";
    const season = Number(data.parentIndex);
    const episode = Number(data.index);
    if (!show || !Number.isInteger(season) || !Number.isInteger(episode)) continue;
    const values = index.get(show) ?? [];
    values.push({
      ratingKey: row.rating_key,
      title: row.title,
      show,
      season,
      episode,
      showRatingKey: typeof data.grandparentRatingKey === "string" ? data.grandparentRatingKey : null,
    });
    index.set(show, values);
  }
  return index;
}


export type ProposalRecord = NamingProposal & {
  decisionStatus: ProposalDecisionStatus | "unreviewed";
  decisionNote: string | null;
  decisionUpdatedAt: string | null;
  decisionStale: boolean;
};

type DecisionRow = {
  file_record_id: number;
  evidence_key: string;
  status: ProposalDecisionStatus;
  note: string | null;
  updated_at: string;
};

function readDecisions(ownerId: string) {
  const rows = archiveDb.prepare(
    `SELECT file_record_id, evidence_key, status, note, updated_at
     FROM naming_proposal_decision
     WHERE owner_id = ?`,
  ).all(ownerId) as DecisionRow[];
  return new Map(rows.map((row) => [row.file_record_id, row]));
}

// A stored decision only counts while it matches the current evidence. When
// the underlying file or proposal evidence changes, the decision goes stale
// and the proposal reopens for review instead of silently remaining accepted.
function withDecision(proposal: NamingProposal, decisions: Map<number, DecisionRow>): ProposalRecord {
  const stored = decisions.get(proposal.fileRecordId);
  if (!stored || stored.evidence_key !== proposal.evidenceKey) {
    return {
      ...proposal,
      decisionStatus: "unreviewed",
      decisionNote: null,
      decisionUpdatedAt: stored?.updated_at ?? null,
      decisionStale: Boolean(stored),
    };
  }
  return {
    ...proposal,
    decisionStatus: stored.status,
    decisionNote: stored.note,
    decisionUpdatedAt: stored.updated_at,
    decisionStale: false,
  };
}

export async function buildNamingProposals(ownerId: string, settings: SettingsRecord = readSettings()): Promise<ProposalRecord[]> {
  const rows = readRows(ownerId);
  const volumes = namingVolumes(settings);
  const plexByShow = readPlexEpisodes(ownerId);
  const knownPaths = new Set(rows.map((row) => row.path.toLowerCase()));
  const decisions = readDecisions(ownerId);
  const proposals: ProposalRecord[] = [];
  for (let start = 0; start < rows.length; start += 500) {
    for (const row of rows.slice(start, start + 500)) {
      const volume = volumeForPath(row.path, volumes);
      if (!volume) continue;
      if (volume.mediaType === "tv") {
        proposals.push(withDecision(makeProposal(row, volume, parseCandidate(row, volume), knownPaths, plexByShow), decisions));
      } else {
        proposals.push(withDecision(makeMovieProposal(row, volume), decisions));
      }
    }
    await setImmediate();
  }
  return proposals;
}

export async function readNamingProposals(
  ownerId: string,
  filters: { page?: number; pageSize?: number; confidence?: string; operation?: string; pattern?: string; mediaType?: string; volume?: string; state?: string; uncertain?: boolean; decision?: string } = {},
) {
  const proposals = await buildNamingProposals(ownerId);
  const filtered = proposals.filter((proposal) => {
    if (filters.confidence && proposal.confidence !== filters.confidence) return false;
    if (filters.operation && proposal.operation !== filters.operation) return false;
    if (filters.pattern && proposal.patternId !== filters.pattern) return false;
    if (filters.mediaType && proposal.mediaType !== filters.mediaType) return false;
    if (filters.volume && proposal.volumeId !== filters.volume) return false;
    if (filters.state && ((filters.state === "uncertain") !== (proposal.operation === "uncertain/no_action"))) return false;
    if (filters.uncertain !== undefined && (proposal.operation === "uncertain/no_action") !== filters.uncertain) return false;
    if (filters.decision && proposal.decisionStatus !== filters.decision) return false;
    return true;
  });
  const pageSize = Math.max(1, Math.min(500, Number.isInteger(filters.pageSize) ? filters.pageSize ?? 100 : 100));
  const page = Math.max(1, Number.isInteger(filters.page) ? filters.page ?? 1 : 1);
  const offset = (page - 1) * pageSize;
  return {
    summary: {
      total: proposals.length,
      highConfidence: proposals.filter((proposal) => proposal.confidence === "high").length,
      mediumConfidence: proposals.filter((proposal) => proposal.confidence === "medium").length,
      lowConfidence: proposals.filter((proposal) => proposal.confidence === "low").length,
      actionable: proposals.filter((proposal) => proposal.operation !== "uncertain/no_action").length,
      uncertain: proposals.filter((proposal) => proposal.operation === "uncertain/no_action").length,
      collisions: proposals.filter((proposal) => proposal.collision).length,
      acceptedCount: proposals.filter((proposal) => proposal.decisionStatus === "accepted").length,
      rejectedCount: proposals.filter((proposal) => proposal.decisionStatus === "rejected").length,
      deferredCount: proposals.filter((proposal) => proposal.decisionStatus === "deferred").length,
      staleDecisionCount: proposals.filter((proposal) => proposal.decisionStale).length,
    },
    pagination: {
      page,
      pageSize,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / pageSize),
    },
    results: filtered.slice(offset, offset + pageSize),
  };
}

// Phase 4: durable, evidence-bound proposal decisions. Accepting is gated on
// the proposal being executable right now (an actual destination, no
// collision); rejecting and deferring stay available for every proposal.
export const NAMING_DECISION_BATCH_LIMIT = 100;

export async function setNamingProposalDecisions(
  ownerId: string,
  items: Array<{ fileRecordId: number; status: ProposalDecisionStatus; note?: string | null }>,
) {
  const proposals = new Map((await buildNamingProposals(ownerId)).map((proposal) => [proposal.fileRecordId, proposal]));
  const upsert = archiveDb.prepare(
    `INSERT INTO naming_proposal_decision
      (owner_id, file_record_id, evidence_key, status, note, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(owner_id, file_record_id) DO UPDATE SET
       evidence_key = excluded.evidence_key,
       status = excluded.status,
       note = excluded.note,
       updated_at = CURRENT_TIMESTAMP`,
  );
  const results = items.map((item) => {
    const proposal = proposals.get(item.fileRecordId);
    if (!proposal) {
      return { fileRecordId: item.fileRecordId, success: false, decision: null, error: "No current naming proposal exists for this archive record." };
    }
    if (item.status === "accepted" && (proposal.operation === "uncertain/no_action" || !proposal.proposedPath)) {
      return {
        fileRecordId: item.fileRecordId,
        success: false,
        decision: null,
        error: `This proposal has no executable destination (${proposal.patternId}); it can be rejected or deferred but not accepted.`,
      };
    }
    upsert.run(ownerId, proposal.fileRecordId, proposal.evidenceKey, item.status, item.note ?? null);
    const saved = archiveDb.prepare(
      "SELECT status, note, updated_at FROM naming_proposal_decision WHERE owner_id = ? AND file_record_id = ?",
    ).get(ownerId, proposal.fileRecordId) as { status: ProposalDecisionStatus; note: string | null; updated_at: string };
    return {
      fileRecordId: item.fileRecordId,
      success: true,
      decision: {
        status: saved.status,
        evidenceKey: proposal.evidenceKey,
        note: saved.note,
        updatedAt: saved.updated_at,
      },
      error: null,
    };
  });
  const succeeded = results.filter((result) => result.success).length;
  return {
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}
