import { archiveDb } from "../lib/archive-db";

type ProviderRow = Record<string, unknown>;

export type MediaExperienceItem = {
  key: string;
  provider: "plex" | "jellyfin";
  title: string;
  itemType: "movie" | "show" | "episode" | "unknown";
  year: number | null;
  releaseDate: string | null;
  genres: string[];
  durationMinutes: number | null;
  status: "completed" | "in_progress" | "unwatched" | "unknown";
  progressPercent: number | null;
  playCount: number;
  lastWatchedAt: string | null;
  watchedMinutes: number;
  seriesTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  seriesProgress: number | null;
  isNextEpisode: boolean;
  evidence: string[];
  libraryName: string | null;
  mediaOrigin: "canonical_series" | "youtube_channel_archive" | "personal_media_archive" | "unknown";
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function number(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function metadataJson(value: unknown) {
  try {
    return record(JSON.parse(String(value ?? "{}")));
  } catch {
    return {};
  }
}
function itemType(value: unknown): MediaExperienceItem["itemType"] {
  return value === "movie" || value === "show" || value === "episode" ? value : "unknown";
}
function mediaOrigin(libraryName: string | null, metadata: Record<string, unknown>, title: string): MediaExperienceItem["mediaOrigin"] {
  const signal = `${libraryName ?? ""} ${String(metadata.uploader ?? metadata.channelTitle ?? metadata.channel ?? "")} ${title}`.toLowerCase();
  if (/youtube|yt channel|creator archive|channel archive/.test(signal)) return "youtube_channel_archive";
  if (/personal|home archive|my archive|family archive|private collection/.test(signal)) return "personal_media_archive";
  if (/episode|season|series|show|tv/.test(signal)) return "canonical_series";
  return "unknown";
}

function plexItems(ownerId: string): MediaExperienceItem[] {
  const rows = archiveDb.prepare(`
    SELECT i.rating_key, i.title, i.item_type, i.year, i.metadata_json, l.name AS library_name,
      COALESCE(MAX(m.duration_ms), 0) AS duration_ms
    FROM plex_item i
    JOIN plex_library l ON l.id = i.library_id AND l.owner_id = i.owner_id
    LEFT JOIN plex_media m ON m.item_id = i.id
    WHERE i.owner_id = ?
    GROUP BY i.id
  `).all(ownerId) as ProviderRow[];
  return rows.map((row) => {
    const metadata = metadataJson(row.metadata_json);
    const durationMs = number(row.duration_ms) ?? number(metadata.duration);
    const playCount = Math.max(0, Math.floor(number(metadata.viewCount) ?? 0));
    const offsetMs = Math.max(0, number(metadata.viewOffset) ?? 0);
    const watchedAt = number(metadata.lastViewedAt);
    const progress = durationMs && durationMs > 0 ? Math.min(1, offsetMs / durationMs) : null;
    const completed = playCount > 0 || (progress !== null && progress >= 0.9);
    return {
      key: `plex:${String(row.rating_key)}`, provider: "plex", title: String(row.title),
      itemType: itemType(row.item_type), year: row.year == null ? null : Number(row.year),
      releaseDate: text(metadata.originallyAvailableAt),
      genres: Array.isArray(metadata.Genre) ? metadata.Genre.filter((value): value is string => typeof value === "string") : [],
      durationMinutes: durationMs && durationMs > 0 ? Math.round(durationMs / 60000) : null,
      status: completed ? "completed" : offsetMs > 0 ? "in_progress" : "unwatched",
      progressPercent: completed ? 100 : progress === null ? null : Math.round(progress * 100),
      playCount, lastWatchedAt: watchedAt ? new Date(watchedAt * 1000).toISOString() : null,
      watchedMinutes: Math.round(((durationMs && durationMs > 0 ? (completed ? durationMs * Math.max(1, playCount) : offsetMs) : 0) / 60000) * 10) / 10,
      seriesTitle: text(metadata.grandparentTitle),
      seasonNumber: number(metadata.parentIndex),
      episodeNumber: number(metadata.index),
      seriesProgress: null,
      isNextEpisode: false,
      evidence: ["Plex library metadata",  ...(playCount ? [`Plex view count: ${playCount}`] : []), ...(offsetMs ? ["Plex playback offset"] : [])],
      libraryName: text(row.library_name), mediaOrigin: mediaOrigin(text(row.library_name), metadata, String(row.title)),
    };
  });
}

function jellyfinItems(ownerId: string): MediaExperienceItem[] {
  const rows = archiveDb.prepare(`
    SELECT i.item_key, i.title, i.item_type, i.year, i.metadata_json, l.name AS library_name,
      COALESCE(MAX(m.duration_ms), 0) AS duration_ms
    FROM jellyfin_item i
    JOIN jellyfin_library l ON l.id = i.library_id AND l.owner_id = i.owner_id
    LEFT JOIN jellyfin_media m ON m.item_id = i.id
    WHERE i.owner_id = ?
    GROUP BY i.id
  `).all(ownerId) as ProviderRow[];
  return rows.map((row) => {
    const metadata = metadataJson(row.metadata_json);
    const userData = record(metadata.UserData);
    const durationMs = number(row.duration_ms) ?? (number(metadata.RunTimeTicks) === null ? null : number(metadata.RunTimeTicks)! / 10000);
    const playCount = Math.max(0, Math.floor(number(userData.PlayCount) ?? 0));
    const positionMs = (number(userData.PlaybackPositionTicks) ?? 0) / 10000;
    const progress = durationMs && durationMs > 0 ? Math.min(1, positionMs / durationMs) : null;
    const completed = userData.Played === true || playCount > 0 || (progress !== null && progress >= 0.9);
    return {
      key: `jellyfin:${String(row.item_key)}`, provider: "jellyfin", title: String(row.title),
      itemType: itemType(row.item_type), year: row.year == null ? null : Number(row.year),
      releaseDate: text(metadata.PremiereDate),
      genres: Array.isArray(metadata.Genres) ? metadata.Genres.filter((value): value is string => typeof value === "string") : [],
      durationMinutes: durationMs && durationMs > 0 ? Math.round(durationMs / 60000) : null,
      status: completed ? "completed" : positionMs > 0 ? "in_progress" : "unwatched",
      progressPercent: completed ? 100 : progress === null ? null : Math.round(progress * 100),
      playCount, lastWatchedAt: text(userData.LastPlayedDate),
      watchedMinutes: Math.round(((durationMs && durationMs > 0 ? (completed ? durationMs * Math.max(1, playCount) : positionMs) : 0) / 60000) * 10) / 10,
      seriesTitle: text(metadata.SeriesName),
      seasonNumber: number(metadata.ParentIndexNumber),
      episodeNumber: number(metadata.IndexNumber),
      seriesProgress: null,
      isNextEpisode: false,
      evidence: ["Jellyfin user playback metadata",  ...(playCount ? [`Jellyfin play count: ${playCount}`] : []), ...(positionMs ? ["Jellyfin playback position"] : [])],
      libraryName: text(row.library_name), mediaOrigin: mediaOrigin(text(row.library_name), metadata, String(row.title)),
    };
  });
}

/**
 * This is deliberately a read model over provider evidence. It does not write
 * playback state and does not treat an archive sync as a viewing event.
 */
export function readMediaExperience(ownerId: string) {
  const items = [...plexItems(ownerId), ...jellyfinItems(ownerId)];
  const episodes = items.filter((item) => item.itemType === "episode" && item.seriesTitle && item.seasonNumber !== null && item.episodeNumber !== null);
  const series = new Map<string, MediaExperienceItem[]>();
  for (const item of episodes) {
    const values = series.get(item.seriesTitle!) ?? [];
    values.push(item);
    series.set(item.seriesTitle!, values);
  }
  for (const values of series.values()) {
    const watchedEpisodes = values.filter((item) => item.status === "completed").length;
    for (const item of values) {
      item.seriesProgress = Math.round((watchedEpisodes / values.length) * 100);
    }
    const next = values.filter((item) => item.status === "unwatched")
      .sort((left, right) => (left.seasonNumber! - right.seasonNumber!) || (left.episodeNumber! - right.episodeNumber!));
    if (next.length > 0) next[0].isNextEpisode = true;
  }
  const completed = items.filter((item) => item.status === "completed");
  const inProgress = items.filter((item) => item.status === "in_progress");
  const watchedMinutes = items.reduce((total, item) => total + item.watchedMinutes, 0);
  const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentlyWatched = items.filter((item) => item.lastWatchedAt && Date.parse(item.lastWatchedAt) >= recentCutoff);
  return {
    sourceStatus: items.length ? "provider_metadata" as const : "no_synced_provider_data" as const,
    items,
    completed,
    inProgress,
    summary: {
      completedCount: completed.length,
      inProgressCount: inProgress.length,
      watchedMinutes,
      watchedHours: Math.round((watchedMinutes / 60) * 10) / 10,
    },
    currentViewingMomentum: {
      activeSeriesCount: new Set(inProgress.map((item) => item.seriesTitle ?? item.title)).size,
      recentlyWatchedCount: recentlyWatched.length,
      windowDays: 30,
    },
    watchlist: { status: "not_available" as const, items: [] as MediaExperienceItem[] },
  };
}

export function buildViewingPrioritySignals(media: ReturnType<typeof readMediaExperience>) {
  const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return media.items.map((item) => {
    const reasons: string[] = [];
    let score = 0;
    if (item.isNextEpisode) { score += 50; reasons.push("next unwatched episode"); }
    if (item.status === "in_progress") { score += 35; reasons.push("currently in progress"); }
    if (item.lastWatchedAt && Date.parse(item.lastWatchedAt) >= recentCutoff) { score += 25; reasons.push("watched within the last 30 days"); }
    if (item.playCount >= 2) { score += 20; reasons.push(`rewatched ${item.playCount} times`); }
    if (item.seriesProgress !== null && item.seriesProgress > 0) { score += Math.min(15, Math.round(item.seriesProgress / 10)); reasons.push(`series progress ${item.seriesProgress}%`); }
    return { key: item.key, title: item.title, seriesTitle: item.seriesTitle, itemType: item.itemType, libraryName: item.libraryName, mediaOrigin: item.mediaOrigin, score, reasons };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.title.localeCompare(right.title)).slice(0, 100);
}

export function buildArchiveOriginResearch(media: ReturnType<typeof readMediaExperience>) {
  const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const groups = new Map<string, typeof media.items>();
  for (const item of media.items) { const key = `${item.mediaOrigin}:${item.libraryName ?? "unknown"}`; groups.set(key, [...(groups.get(key) ?? []), item]); }
  return [...groups.entries()].map(([key, items]) => {
    const [origin, libraryName] = key.split(":");
    const recent = items.filter((item) => item.lastWatchedAt && Date.parse(item.lastWatchedAt) >= recentCutoff);
    const repeated = items.filter((item) => item.playCount >= 2);
    const policy = origin === "youtube_channel_archive"
      ? "Treat as a channel/upload stream: prioritize recent uploads, repeated channels, and viewing cadence; do not force TV episode metadata research."
      : origin === "personal_media_archive"
        ? "Treat as personal archive evidence: use viewing behavior, never infer public release availability."
        : origin === "canonical_series"
          ? "Use season, episode, release, cast, and creator research when identity confidence supports it."
          : "Classify further before applying external research.";
    return { origin, libraryName, itemCount: items.length, activeCount: items.filter((item) => item.status === "in_progress").length, recentWatchedCount: recent.length, repeatedCount: repeated.length, nextEpisodeCount: items.filter((item) => item.isNextEpisode).length, topItems: [...items].sort((a, b) => b.playCount - a.playCount || String(b.lastWatchedAt).localeCompare(String(a.lastWatchedAt))).slice(0, 10).map((item) => ({ key: item.key, title: item.title, seriesTitle: item.seriesTitle, playCount: item.playCount, lastWatchedAt: item.lastWatchedAt, status: item.status })), researchPolicy: policy };
  });
}
