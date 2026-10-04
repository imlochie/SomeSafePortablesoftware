import { readMediaExperience } from "./media-experience";

type Evidence = { source: string; field: string; value: string; kind: "observed" | "derived" };
type Cluster = { id: string; label: string; basis: string[]; watchedCount: number; completedCount: number; rewatchedCount: number; archivedCount: number; recentWatchedCount: number; evidence: Evidence[] };

function decade(year: number | null) { return year === null ? null : `${Math.floor(year / 10) * 10}s`; }
function recent(date: string | null, days: number) { return Boolean(date && Date.parse(date) >= Date.now() - days * 86400000); }

export function buildMediaProfile(media: ReturnType<typeof readMediaExperience>) {
  const watched = media.items.filter((item) => item.status !== "unwatched");
  const inProgress = media.inProgress ?? media.items.filter((item) => item.status === "in_progress");
  const momentum = media.currentViewingMomentum ?? { activeSeriesCount: 0 };
  const summary = media.summary ?? { watchedHours: 0 };
  const completed = media.items.filter((item) => item.status === "completed");
  const rewatched = media.items.filter((item) => item.playCount >= 2);
  const recentItems = watched.filter((item) => recent(item.lastWatchedAt, 30));
  const genres = new Map<string, typeof media.items>();
  for (const item of watched) for (const genre of item.genres) genres.set(genre, [...(genres.get(genre) ?? []), item]);
  const clusters: Cluster[] = [...genres.entries()].map(([genre, items]) => ({
    id: `genre:${genre.toLowerCase()}`, label: genre, basis: ["provider genre metadata"],
    watchedCount: items.length, completedCount: items.filter((item) => item.status === "completed").length,
    rewatchedCount: items.filter((item) => item.playCount >= 2).length,
    archivedCount: media.items.filter((item) => item.genres.includes(genre)).length,
    recentWatchedCount: items.filter((item) => recent(item.lastWatchedAt, 30)).length,
    evidence: [{ source: "Plex/Jellyfin", field: "genre", value: genre, kind: "observed" as const }, { source: "media-experience", field: "clusterCounts", value: `${items.length} watched`, kind: "derived" as const }],
  })).sort((left, right) => right.watchedCount - left.watchedCount || left.label.localeCompare(right.label));
  const archiveItems = media.items.filter((item) => item.provider === "plex" || item.provider === "jellyfin");
  return {
    viewing: {
      totalItems: media.items.length, watchedItems: watched.length, completedItems: completed.length,
      inProgressItems: inProgress.length, estimatedWatchedHours: summary.watchedHours,
      recentlyWatchedCount: recentItems.length, rewatchedCount: rewatched.length,
      activeSeriesCount: momentum.activeSeriesCount,
      moviesWatched: watched.filter((item) => item.itemType === "movie").length,
      episodesWatched: watched.filter((item) => item.itemType === "episode").length,
      timeIsEstimate: true,
    },
    temporal: { recent30DayCount: recentItems.length, recentGenres: clusters.filter((cluster) => cluster.recentWatchedCount > 0).map((cluster) => cluster.label), evidence: [{ source: "media-experience", field: "lastWatchedAt", value: "30-day window", kind: "derived" as const }] },
    patterns: { genres: clusters.slice(0, 10), rewatchedTitles: rewatched.slice(0, 20).map((item) => ({ title: item.title, playCount: item.playCount, lastWatchedAt: item.lastWatchedAt })), evidence: [{ source: "media-experience", field: "playCount", value: "repeat viewing", kind: "observed" as const }] },
    archive: { itemCount: archiveItems.length, movies: archiveItems.filter((item) => item.itemType === "movie").length, shows: archiveItems.filter((item) => item.itemType === "show").length, episodes: archiveItems.filter((item) => item.itemType === "episode").length, lowEngagementItems: archiveItems.filter((item) => item.status === "unwatched").length, evidence: [{ source: "Plex/Jellyfin", field: "libraryItems", value: String(archiveItems.length), kind: "observed" as const }] },
    unknowns: ["Watchlist data is unavailable.", "Provider history does not establish psychological preferences.", "Acquisition-to-watch conversion is unavailable without a reliable cross-domain download linkage."],
  };
}

export function buildArchiveGraph(profile: ReturnType<typeof buildMediaProfile>) {
  return {
    clusters: profile.patterns.genres,
    gaps: [],
    redundancies: profile.patterns.genres.filter((cluster) => cluster.archivedCount >= 10 && cluster.watchedCount <= 3).map((cluster) => ({ clusterId: cluster.id, label: cluster.label, reason: "archive density is high while observed engagement is low", evidence: cluster.evidence })),
    relationships: [],
    unknowns: ["Meaningful missing-title gaps require research candidates and reliable cross-provider identity."],
  };
}

export function readMediaProfile(ownerId: string) {
  const media = readMediaExperience(ownerId);
  const profile = buildMediaProfile(media);
  return { profile, archiveGraph: buildArchiveGraph(profile) };
}
