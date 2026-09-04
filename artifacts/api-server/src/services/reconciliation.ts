import { setImmediate } from "node:timers/promises";
import { archiveDb } from "../lib/archive-db";
import { localEpisodeIdentity, normalizeTitle, titleYear } from "./archive";

export type ReconciliationClassification =
  | "matched"
  | "local_only"
  | "plex_only"
  | "duplicate"
  | "quality_conflict"
  | "uncertain";

type LocalRow = {
  id: number;
  local_identity_id: number | null;
  path: string;
  relative_path: string;
  volume_id: string | null;
  archive_root: string | null;
  filename: string;
  media_type: string | null;
  year: number | null;
  normalized_title: string | null;
  show_identity: string | null;
  season_number: number | null;
  episode_number: number | null;
  size_bytes: number | null;
  checksum: string | null;
  fingerprint: string | null;
  height: number | null;
  dynamic_range: string | null;
  video_codec: string | null;
  bitrate: number | null;
  audio_codec: string | null;
  audio_channels: number | null;
  container: string | null;
  scan_status: string;
};

type PlexRow = {
  id: number;
  library_id: number;
  library_name: string;
  rating_key: string;
  title: string;
  item_type: string;
  year: number | null;
  metadata_json: string;
  video_resolution: string | null;
  video_codec: string | null;
  bitrate: number | null;
  audio_codec: string | null;
};

type Identity = {
  kind: "tv" | "movie";
  key: string;
  strategy: "tv_show_season_episode" | "movie_title_year" | "fallback_title_year";
  fields: Record<string, string | number | null>;
};

type Quality = {
  height: number | null;
  hdr: boolean;
  videoCodec: string | null;
  bitrate: number | null;
  audioCodec: string | null;
  audioChannels: number | null;
  container: string | null;
};

type CandidateIndex = Map<string, PlexRow[]>;

function metadata(row: PlexRow) {
  try {
    const value: unknown = JSON.parse(row.metadata_json);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function localIdentity(row: LocalRow): Identity | null {
  const parsed = localEpisodeIdentity(row.filename);
  const isTv = parsed !== null || row.media_type === "tv" || row.show_identity !== null || row.season_number !== null;
  if (isTv) {
    const show = row.show_identity ?? parsed?.show ?? null;
    const season = row.season_number ?? parsed?.season ?? null;
    const episode = row.episode_number ?? parsed?.episode ?? null;
    if (show && Number.isInteger(season) && Number.isInteger(episode)) {
      return {
        kind: "tv",
        key: `${show}:${season}:${episode}`,
        strategy: "tv_show_season_episode",
        fields: { show, season, episode },
      };
    }
    return null;
  }
  const normalizedTitle = row.normalized_title ?? normalizeTitle(row.filename);
  if (!normalizedTitle) return null;
  const year = row.year ?? titleYear(row.filename);
  return {
    kind: "movie",
    key: `${normalizedTitle}:${year ?? ""}`,
    strategy: year === null ? "fallback_title_year" : "movie_title_year",
    fields: { title: normalizedTitle, year },
  };
}

function plexIdentity(row: PlexRow): Identity | null {
  const data = metadata(row);
  if (row.item_type === "episode") {
    const show = text(data.grandparentTitle);
    const season = number(data.parentIndex);
    const episode = number(data.index);
    if (!show || !Number.isInteger(season) || !Number.isInteger(episode)) return null;
    return {
      kind: "tv",
      key: `${normalizeTitle(show)}:${season}:${episode}`,
      strategy: "tv_show_season_episode",
      fields: {
        show: normalizeTitle(show),
        season,
        episode,
        grandparentRatingKey: text(data.grandparentRatingKey),
        parentRatingKey: text(data.parentRatingKey),
        title: row.title,
        ratingKey: row.rating_key,
      },
    };
  }
  if (row.item_type !== "movie") return null;
  const normalizedTitle = normalizeTitle(row.title);
  if (!normalizedTitle) return null;
  return {
    kind: "movie",
    key: `${normalizedTitle}:${row.year ?? ""}`,
    strategy: row.year === null ? "fallback_title_year" : "movie_title_year",
    fields: { title: normalizedTitle, year: row.year },
  };
}

function add(index: CandidateIndex, key: string, row: PlexRow) {
  const values = index.get(key) ?? [];
  values.push(row);
  index.set(key, values);
}

function quality(row: LocalRow | PlexRow): Quality {
  if ("item_type" in row) {
    const data = metadata(row);
    const media = data.media && typeof data.media === "object" && !Array.isArray(data.media)
      ? data.media as Record<string, unknown>
      : {};
    return {
      height: row.video_resolution ? Number.parseInt(row.video_resolution.replace(/\D/g, ""), 10) || null : null,
      hdr: Boolean(typeof data.dynamicRange === "string" && /hdr|smpte2084|arib-std-b67|hlg/i.test(data.dynamicRange)),
      videoCodec: row.video_codec,
      bitrate: row.bitrate,
      audioCodec: row.audio_codec,
      audioChannels: number(media.audioChannels),
      container: text(media.container),
    };
  }
  return {
    height: row.height,
    hdr: Boolean(row.dynamic_range && /hdr|smpte2084|arib-std-b67|hlg/i.test(row.dynamic_range)),
    videoCodec: row.video_codec,
    bitrate: row.bitrate,
    audioCodec: row.audio_codec,
    audioChannels: row.audio_channels,
    container: row.container,
  };
}

function qualityDifferences(left: Quality, right: Quality) {
  const differences: string[] = [];
  if (left.height !== right.height && (left.height !== null || right.height !== null)) differences.push("resolution");
  if (left.hdr !== right.hdr) differences.push("dynamic_range");
  if (left.videoCodec !== right.videoCodec) differences.push("video_codec");
  if (left.bitrate !== right.bitrate && (left.bitrate !== null || right.bitrate !== null)) differences.push("bitrate");
  if (left.audioCodec !== right.audioCodec) differences.push("audio_codec");
  if (left.audioChannels !== right.audioChannels && (left.audioChannels !== null || right.audioChannels !== null)) differences.push("audio_channels");
  if (left.container !== right.container) differences.push("container");
  return differences;
}

function localDetails(row: LocalRow, identity: Identity | null) {
  return {
    fileRecordId: row.id,
    localMediaIdentityId: row.local_identity_id,
    path: row.path,
    relativePath: row.relative_path,
    volumeId: row.volume_id,
    archiveRoot: row.archive_root,
    mediaType: row.media_type,
    identity: identity ? { ...identity.fields, strategy: identity.strategy } : null,
    scanStatus: row.scan_status,
  };
}

function plexDetails(row: PlexRow, identity: Identity | null) {
  return {
    id: row.id,
    ratingKey: row.rating_key,
    libraryId: row.library_id,
    libraryName: row.library_name,
    title: row.title,
    year: row.year,
    itemType: row.item_type,
    identity: identity ? { ...identity.fields, strategy: identity.strategy } : null,
  };
}

function readLocalRows(ownerId: string) {
  return archiveDb.prepare(`
    SELECT f.id, f.local_identity_id, f.path, f.relative_path, f.volume_id, f.archive_root,
           f.filename, f.media_type, f.size_bytes, f.checksum, f.fingerprint,
           f.height, f.dynamic_range, f.video_codec, f.bitrate, f.audio_codec,
           f.audio_channels, f.container, f.scan_status,
           i.year, i.normalized_title, i.show_identity, i.season_number, i.episode_number
    FROM file_record f
    LEFT JOIN local_media_identity i ON i.id = f.local_identity_id AND i.owner_id = f.owner_id
    WHERE f.owner_id = ?
    ORDER BY f.id
  `).all(ownerId) as LocalRow[];
}

function readPlexRows(ownerId: string) {
  return archiveDb.prepare(`
    SELECT i.id, i.library_id, l.name AS library_name, i.rating_key, i.title, i.item_type,
           i.year, i.metadata_json, pm.video_resolution,
           pm.video_codec, pm.bitrate, pm.audio_codec
    FROM plex_item i
    JOIN plex_library l ON l.id = i.library_id AND l.owner_id = i.owner_id
    LEFT JOIN plex_media pm ON pm.id = (
      SELECT MIN(pm2.id) FROM plex_media pm2 WHERE pm2.item_id = i.id
    )
    WHERE i.owner_id = ?
    ORDER BY i.id
  `).all(ownerId) as PlexRow[];
}

function pageNumber(value: number | undefined, fallback: number, max: number) {
  return Number.isInteger(value) ? Math.max(1, Math.min(max, value as number)) : fallback;
}

export async function readReconciliationReport(
  ownerId: string,
  page = 1,
  pageSize = 100,
) {
  const localRows = readLocalRows(ownerId);
  const plexRows = readPlexRows(ownerId);
  const plexByExactIdentity: CandidateIndex = new Map();
  const plexByTitle: CandidateIndex = new Map();
  const plexIdentities = new Map<string, Identity | null>();
  for (const row of plexRows) {
    const identity = plexIdentity(row);
    plexIdentities.set(row.rating_key, identity);
    if (!identity) continue;
    add(plexByExactIdentity, `${identity.kind}:${identity.key}`, row);
    if (identity.kind === "movie") add(plexByTitle, `movie:${String(identity.fields.title)}`, row);
  }

  const localIdentities = new Map<number, Identity | null>();
  const localByIdentity = new Map<string, LocalRow[]>();
  const localByChecksum = new Map<string, LocalRow[]>();
  const localByFingerprint = new Map<string, LocalRow[]>();
  for (const row of localRows) {
    const identity = localIdentity(row);
    localIdentities.set(row.id, identity);
    if (row.checksum) {
      const checksumRows = localByChecksum.get(row.checksum) ?? [];
      checksumRows.push(row);
      localByChecksum.set(row.checksum, checksumRows);
    }
    if (row.fingerprint) {
      const fingerprintRows = localByFingerprint.get(row.fingerprint) ?? [];
      fingerprintRows.push(row);
      localByFingerprint.set(row.fingerprint, fingerprintRows);
    }
    if (!identity) continue;
    const values = localByIdentity.get(`${identity.kind}:${identity.key}`) ?? [];
    values.push(row);
    localByIdentity.set(`${identity.kind}:${identity.key}`, values);
  }

  const results: Array<Record<string, unknown>> = [];
  const confirmedPlexKeys = new Set<string>();
  const ambiguousPlexKeys = new Set<string>();
  for (let start = 0; start < localRows.length; start += 500) {
    for (const row of localRows.slice(start, start + 500)) {
      const identity = localIdentities.get(row.id) ?? null;
      const exact = identity
        ? plexByExactIdentity.get(`${identity.kind}:${identity.key}`) ?? []
        : [];
      const candidates = exact.length || !identity || identity.kind !== "movie"
        ? exact
        : (plexByTitle.get(`movie:${String(identity.fields.title)}`) ?? []).filter((candidate) =>
          candidate.year === null || identity.fields.year === null || candidate.year === identity.fields.year);
      const sameIdentity = identity ? localByIdentity.get(`${identity.kind}:${identity.key}`) ?? [] : [];
      const physicalDuplicates = [
        ...(row.checksum ? localByChecksum.get(row.checksum) ?? [] : []),
        ...(row.fingerprint ? localByFingerprint.get(row.fingerprint) ?? [] : []),
      ].filter((candidate, index, values) => candidate.id !== row.id
        && values.findIndex((value) => value.id === candidate.id) === index);
      const contradictoryPhysicalDuplicate = physicalDuplicates.some((candidate) => {
        const candidateIdentity = localIdentities.get(candidate.id) ?? null;
        return Boolean(identity && candidateIdentity
          && `${identity.kind}:${identity.key}` !== `${candidateIdentity.kind}:${candidateIdentity.key}`);
      });
      const duplicateStrategy = row.checksum && (localByChecksum.get(row.checksum)?.length ?? 0) > 1
        ? "checksum"
        : row.fingerprint && (localByFingerprint.get(row.fingerprint)?.length ?? 0) > 1
          ? "fingerprint"
          : "semantic_identity";
      let classification: ReconciliationClassification = "local_only";
      let strategy = identity?.strategy ?? "no_match";
      let qualityResult: Record<string, unknown> = { status: "not_compared", differences: [] };
      if (candidates.length > 1) {
        classification = "uncertain";
        strategy = "ambiguous";
        for (const candidate of candidates) ambiguousPlexKeys.add(candidate.rating_key);
      } else if (candidates.length === 1) {
        const candidate = candidates[0];
        confirmedPlexKeys.add(candidate.rating_key);
        const differences = qualityDifferences(quality(row), quality(candidate));
        qualityResult = {
          status: differences.length ? "conflict" : "equivalent_available_metadata",
          differences,
        };
        classification = contradictoryPhysicalDuplicate
          ? "uncertain"
          : sameIdentity.length > 1
          ? "duplicate"
          : differences.length ? "quality_conflict" : "matched";
      } else if (sameIdentity.length > 1) {
        classification = "duplicate";
        strategy = duplicateStrategy;
      } else if (physicalDuplicates.length > 0) {
        classification = contradictoryPhysicalDuplicate ? "uncertain" : "duplicate";
        strategy = contradictoryPhysicalDuplicate ? "ambiguous" : duplicateStrategy;
      }
      results.push({
        classification,
        matchingStrategy: strategy,
        candidateCount: candidates.length,
        local: localDetails(row, identity),
        plex: candidates.length === 1 ? plexDetails(candidates[0], plexIdentities.get(candidates[0].rating_key) ?? null) : null,
        ambiguityCandidates: candidates.length > 1 ? candidates.map((candidate) => plexDetails(candidate, plexIdentities.get(candidate.rating_key) ?? null)) : [],
        quality: qualityResult,
      });
    }
    await setImmediate();
  }

  for (const row of plexRows) {
    if (confirmedPlexKeys.has(row.rating_key) || ambiguousPlexKeys.has(row.rating_key)) continue;
    const identity = plexIdentities.get(row.rating_key) ?? null;
    results.push({
      classification: "plex_only",
      matchingStrategy: "no_match",
      candidateCount: 0,
      local: null,
      plex: plexDetails(row, identity),
      ambiguityCandidates: [],
      quality: { status: "not_compared", differences: [] },
    });
  }

  const normalizedPage = pageNumber(page, 1, 100_000);
  const normalizedPageSize = pageNumber(pageSize, 100, 500);
  const offset = (normalizedPage - 1) * normalizedPageSize;
  const counts = new Map<ReconciliationClassification, number>();
  for (const result of results) {
    const classification = result.classification as ReconciliationClassification;
    counts.set(classification, (counts.get(classification) ?? 0) + 1);
  }
  return {
    summary: {
      localCount: localRows.length,
      plexCount: plexRows.length,
      matchedCount: counts.get("matched") ?? 0,
      localOnlyCount: counts.get("local_only") ?? 0,
      plexOnlyCount: counts.get("plex_only") ?? 0,
      uncertainCount: counts.get("uncertain") ?? 0,
      duplicateCount: counts.get("duplicate") ?? 0,
      qualityConflictCount: counts.get("quality_conflict") ?? 0,
    },
    pagination: {
      page: normalizedPage,
      pageSize: normalizedPageSize,
      total: results.length,
      totalPages: Math.ceil(results.length / normalizedPageSize),
    },
    results: results.slice(offset, offset + normalizedPageSize),
  };
}
