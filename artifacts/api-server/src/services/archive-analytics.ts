import { archiveDb } from "../lib/archive-db";
import { readPlexHistoryPage } from "./plex";

export type WatchObservation = {
  providerEventId: string;
  mediaIdentity: string;
  mediaType: "movie" | "episode" | "show" | "unknown";
  title: string;
  year?: number | null;
  startedAt?: string | null;
  viewedAt: string;
  durationObservedSeconds?: number | null;
  durationSemantics?: "observed_playback" | "provider_reported" | "derived" | "estimated" | "unknown";
  accountId?: string | null;
  clientDevice?: string | null;
  source?: string;
  provider?: string;
  scopeIdentity?: string;
  provenance?: Record<string, unknown>;
  // Provider adapters exclude unsupported/live events before persistence.
  eventType?: "history" | "live" | "dvr";
  accountEligible?: boolean;
  libraryIdentity?: string | null;
};

export type WatchIngestionScope = {
  identity: string;
  allowedMediaTypes?: Array<"movie" | "episode">;
  excludedEventTypes?: Array<"live" | "dvr">;
  allowedLibraries?: string[];
};

export type AnalyticsFact<T> = {
  value: T;
  epistemicStatus: "observed" | "derived" | "coverage-limited" | "unknown";
  provenance: { source: string; observedAt: string; coverage?: string; eventIds?: number[] };
};

function coverage(ownerId: string) {
  return archiveDb.prepare("SELECT * FROM analytics_coverage WHERE owner_id = ? AND provider = 'plex'").get(ownerId) as any;
}

/** Provider adapter boundary: only this function knows Plex history field names. */
export function normalizePlexHistory(history: unknown): WatchObservation[] {
  const root = history && typeof history === "object" ? history as any : {};
  const items = Array.isArray(root.MediaContainer?.Metadata) ? root.MediaContainer.Metadata : Array.isArray(root.metadata) ? root.metadata : [];
  return items.map((item: any) => ({
    providerEventId: String(item.historyKey ?? item.ratingKey ?? item.viewedAt ?? item.addedAt),
    mediaIdentity: String(item.ratingKey ?? item.guid ?? item.title),
    mediaType: item.type === "movie" ? "movie" : item.type === "episode" ? "episode" : "unknown",
    title: String(item.grandparentTitle ? `${item.grandparentTitle} — ${item.title}` : item.title ?? "Unknown title"),
    year: item.year == null ? null : Number(item.year),
    startedAt: item.startedAt ? new Date(Number(item.startedAt) * 1000).toISOString() : null,
    viewedAt: item.viewedAt ? new Date(Number(item.viewedAt) * 1000).toISOString() : new Date().toISOString(),
    durationObservedSeconds: item.duration == null ? null : Number(item.duration) / 1000,
    durationSemantics: item.duration == null ? "unknown" : "provider_reported",
    accountId: item.account?.id ? String(item.account.id) : null,
    clientDevice: item.player?.product ? String(item.player.product) : null,
    source: "plex.history",
    provider: "plex",
    eventType: "history",
    accountEligible: item.account?.id == null || item.account?.filterType !== "shared",
    scopeIdentity: `plex:${item.librarySectionID ?? "all"}`,
    libraryIdentity: item.librarySectionID == null ? null : String(item.librarySectionID),
    provenance: { endpoint: "/status/sessions/history", ratingKey: item.ratingKey ?? null },
  }));
}

export function ingestPlexHistory(ownerId: string, history: unknown, options: {
  historicalCoverageStart?: string | null; collectingSince?: string | null;
  scope?: WatchIngestionScope; ingestionId?: string; updateCoverage?: boolean;
} = {}) {
  return ingestWatchEvents(ownerId, normalizePlexHistory(history), options);
}

/** Ingests provider-independent observations. Provider adapters translate Plex first. */
export async function ingestPlexHistoryFromApi(ownerId: string, options: {
  scope: WatchIngestionScope;
  historicalCoverageStart?: string | null;
  collectingSince?: string | null;
  requestedStart?: string | null;
  requestedEnd?: string | null;
  accountId?: string;
  pageSize?: number;
}): Promise<{
  batchId: string; status: "complete" | "partial" | "failed" | "empty_authoritative";
  completeness: "complete" | "partial" | "failed" | "empty_authoritative";
  pages: number; inserted: number; coveredStart: string | null; coveredEnd: string | null; error?: string;
}> {
  const batchId = `plex-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const pageSize = options.pageSize ?? 500;
  archiveDb.prepare(`INSERT INTO watch_ingestion_batch
    (id, owner_id, provider, scope_identity, requested_start, requested_end, started_at, status, completeness, request_context_json)
    VALUES (?, ?, 'plex', ?, ?, ?, ?, 'running', 'partial', ?)`)
    .run(batchId, ownerId, options.scope.identity, options.requestedStart ?? null, options.requestedEnd ?? null, startedAt,
      JSON.stringify({ pageSize, scope: options.scope }));
  let offset = 0;
  let pages = 0;
  let inserted = 0;
  const acceptedViewedAt: string[] = [];
  let providerTotal: number | null = null;
  try {
    while (true) {
      const page = await readPlexHistoryPage(ownerId, offset, pageSize);
      pages += 1;
      providerTotal = page.totalSize ?? providerTotal;
      const normalized = normalizePlexHistory({ metadata: page.metadata }).map((event) => ({
        ...event,
        scopeIdentity: options.scope.identity,
      }));
      const inWindow = normalized.filter((event) => {
        const time = Date.parse(event.viewedAt);
        return (!options.requestedStart || time >= Date.parse(options.requestedStart))
          && (!options.requestedEnd || time <= Date.parse(options.requestedEnd));
      });
      const result = ingestWatchEvents(ownerId, inWindow, {
        provider: "plex", scope: options.scope, accountId: options.accountId, ingestionId: batchId,
        historicalCoverageStart: options.historicalCoverageStart, collectingSince: options.collectingSince,
        updateCoverage: false,
      });
      inserted += result.inserted;
      acceptedViewedAt.push(...inWindow.map((event) => event.viewedAt));
      if (page.complete) break;
      if (!page.metadata.length) throw new Error("Plex history pagination stopped before the provider total was reached.");
      offset += page.metadata.length;
    }
    const completeness = inserted === 0 && pages > 0 ? "empty_authoritative" : "complete";
    const coveredStart = acceptedViewedAt.length ? new Date(Math.min(...acceptedViewedAt.map(Date.parse))).toISOString() : null;
    const coveredEnd = acceptedViewedAt.length ? new Date(Math.max(...acceptedViewedAt.map(Date.parse))).toISOString() : null;
    if (completeness === "complete") {
      ingestWatchEvents(ownerId, [], { provider: "plex", scope: options.scope, ingestionId: batchId,
        historicalCoverageStart: options.historicalCoverageStart, collectingSince: options.collectingSince });
    }
    archiveDb.prepare(`UPDATE watch_ingestion_batch SET completed_at = ?, status = ?, completeness = ?, page_count = ?,
      accepted_event_count = ?, provider_total = ?, covered_start = ?, covered_end = ? WHERE id = ? AND owner_id = ?`)
      .run(new Date().toISOString(), completeness, completeness, pages, inserted, providerTotal, coveredStart, coveredEnd, batchId, ownerId);
    return { batchId, status: completeness, completeness, pages, inserted, coveredStart, coveredEnd };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Plex history ingestion failed.";
    archiveDb.prepare(`UPDATE watch_ingestion_batch SET completed_at = ?, status = ?, completeness = ?, page_count = ?,
      accepted_event_count = ?, provider_total = ?, error_message = ? WHERE id = ? AND owner_id = ?`)
      .run(new Date().toISOString(), pages ? "partial" : "failed", pages ? "partial" : "failed", pages, inserted, providerTotal, message, batchId, ownerId);
    return { batchId, status: pages ? "partial" : "failed", completeness: pages ? "partial" : "failed", pages, inserted,
      coveredStart: acceptedViewedAt.length ? new Date(Math.min(...acceptedViewedAt.map(Date.parse))).toISOString() : null,
      coveredEnd: acceptedViewedAt.length ? new Date(Math.max(...acceptedViewedAt.map(Date.parse))).toISOString() : null, error: message };
  }
}

export function ingestWatchEvents(ownerId: string, observations: WatchObservation[], options: {
  historicalCoverageStart?: string | null; collectingSince?: string | null;
  provider?: string;
  scopeIdentity?: string;
  scope?: WatchIngestionScope;
  accountId?: string;
  ingestionId?: string;
  updateCoverage?: boolean;
} = {}) {
  const provider = options.provider ?? "plex";
  const configuredScopeIdentity = options.scope?.identity ?? options.scopeIdentity;
  const defaultScopeIdentity = configuredScopeIdentity ?? `${provider}:default`;
  const now = new Date().toISOString();
  const ingestionId = options.ingestionId ?? `${provider}-history-${now}`;
  const allowedMediaTypes = options.scope?.allowedMediaTypes ?? ["movie", "episode"];
  const excludedEventTypes = new Set(options.scope?.excludedEventTypes ?? ["live", "dvr"]);
  const insert = archiveDb.prepare(`INSERT OR IGNORE INTO watch_event
    (owner_id, provider, provider_event_id, media_identity, media_type, title, year, started_at, viewed_at,
     duration_observed_seconds, duration_semantics, account_id, client_device, source, scope_identity,
     historical_coverage_start, collecting_since, ingestion_id, observed_at, provenance_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let inserted = 0;
  const transaction = () => {
    archiveDb.exec("BEGIN IMMEDIATE");
    try {
      for (const event of observations) {
        if (!event.providerEventId.trim() || !event.mediaIdentity.trim()) continue;
        if (event.eventType && event.eventType !== "history") continue;
        if (event.eventType && excludedEventTypes.has(event.eventType)) continue;
        if (event.accountEligible === false) continue;
        if (!allowedMediaTypes.includes(event.mediaType as "movie" | "episode")) continue;
        if (options.accountId && event.accountId !== options.accountId) continue;
        if (options.scope?.allowedLibraries && !options.scope.allowedLibraries.includes(event.libraryIdentity ?? "")) continue;
        if (configuredScopeIdentity && event.scopeIdentity && event.scopeIdentity !== configuredScopeIdentity) continue;
        const acceptedScope = event.scopeIdentity ?? defaultScopeIdentity;
        const result = insert.run(ownerId, provider, event.providerEventId, event.mediaIdentity, event.mediaType,
          event.title, event.year ?? null, event.startedAt ?? null, event.viewedAt, event.durationObservedSeconds ?? null,
          event.durationSemantics ?? (event.durationObservedSeconds == null ? "unknown" : "provider_reported"),
          event.accountId ?? null, event.clientDevice ?? null, event.source ?? `${provider}.history`, acceptedScope,
          options.historicalCoverageStart ?? null, options.collectingSince ?? null, ingestionId, now,
          JSON.stringify({ provider, providerEventId: event.providerEventId, scopeIdentity: acceptedScope,
            ingestionId, historicalCoverageStart: options.historicalCoverageStart ?? null,
            collectingSince: options.collectingSince ?? null, ...(event.provenance ?? {}) }));
        inserted += Number(result.changes);
      }
      if (options.updateCoverage !== false && (options.historicalCoverageStart || options.collectingSince)) {
      archiveDb.prepare(`INSERT INTO analytics_coverage
        (owner_id, provider, historical_coverage_start, collecting_since, last_successful_ingestion, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, provider) DO UPDATE SET
          historical_coverage_start=COALESCE(excluded.historical_coverage_start, historical_coverage_start),
          collecting_since=COALESCE(excluded.collecting_since, collecting_since),
          last_successful_ingestion=excluded.last_successful_ingestion, updated_at=excluded.updated_at`)
          .run(ownerId, provider, options.historicalCoverageStart ?? null, options.collectingSince ?? null, now, now);
      }
      resolveOwnership(ownerId);
      archiveDb.exec("COMMIT");
    } catch (error) {
      archiveDb.exec("ROLLBACK");
      throw error;
    }
  };
  transaction();
  return { inserted, attempted: observations.length, lastSuccessfulIngestion: now };
}

/** Re-evaluates relationship without deleting historical events. */
export function resolveOwnership(ownerId: string) {
  const events = archiveDb.prepare("SELECT id, media_identity FROM watch_event WHERE owner_id = ?").all(ownerId) as any[];
  const current = new Set((archiveDb.prepare("SELECT rating_key, title FROM plex_item WHERE owner_id = ?").all(ownerId) as any[])
    .flatMap((x) => [String(x.rating_key), `title:${String(x.title).toLowerCase()}`]));
  const histories = archiveDb.prepare("SELECT media_identity, departure_confirmed FROM watch_ownership_history WHERE owner_id = ?").all(ownerId) as any[];
  const historical = new Map(histories.map((x) => [x.media_identity, Boolean(x.departure_confirmed)]));
  const update = archiveDb.prepare("UPDATE watch_event SET currently_owned = ?, ownership_resolution = ? WHERE id = ?");
  for (const event of events) {
    const owned = current.has(event.media_identity) || current.has(`title:${event.media_identity.toLowerCase()}`);
    const priorOwnership = historical.get(event.media_identity);
    const state = owned ? "currently_owned" : priorOwnership === true ? "previously_owned"
      : priorOwnership === false ? "departure_unconfirmed" : "never_matched";
    if (owned) {
      archiveDb.prepare(`INSERT INTO watch_ownership_history (owner_id, media_identity, first_owned_at, last_owned_at)
        VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(owner_id, media_identity) DO UPDATE SET last_owned_at = CURRENT_TIMESTAMP`).run(ownerId, event.media_identity);
    }
    update.run(owned ? 1 : 0, state, event.id);
  }
}

/** Called only by Archive Assistant when a controlled archive operation or equivalent evidence confirms departure. */
export function recordConfirmedArchiveDeparture(ownerId: string, mediaIdentity: string, evidence: Record<string, unknown>) {
  const result = archiveDb.prepare(`UPDATE watch_ownership_history
    SET departure_confirmed = 1, departure_at = CURRENT_TIMESTAMP, departure_evidence_json = ?
    WHERE owner_id = ? AND media_identity = ?`).run(JSON.stringify(evidence), ownerId, mediaIdentity);
  if (!Number(result.changes)) throw new Error("Cannot confirm departure without prior ownership evidence.");
  resolveOwnership(ownerId);
}

export function deriveSessions(ownerId: string, gapMinutes = 30) {
  const events = archiveDb.prepare("SELECT * FROM watch_event WHERE owner_id = ? ORDER BY viewed_at, id").all(ownerId) as any[];
  archiveDb.prepare("DELETE FROM watch_session WHERE owner_id = ?").run(ownerId);
  const insert = archiveDb.prepare(`INSERT INTO watch_session
    (owner_id, started_at, ended_at, event_count, duration_observed_seconds, provenance_json) VALUES (?, ?, ?, ?, ?, ?)`);
  let group: any[] = [];
  const flush = () => {
    if (!group.length) return;
    const ids = group.map((e) => e.id);
    const starts = group.map((e) => Date.parse(e.started_at ?? e.viewed_at)).filter(Number.isFinite);
    const ends = group.map((e) => Date.parse(e.viewed_at)).filter(Number.isFinite);
    insert.run(ownerId, new Date(Math.min(...starts)).toISOString(), new Date(Math.max(...ends)).toISOString(), group.length,
      group.reduce((sum, e) => sum + (e.duration_observed_seconds ?? 0), 0) || null,
      JSON.stringify({ derivedFrom: "watch_event", eventIds: ids, rule: `gap <= ${gapMinutes} minutes` }));
    group = [];
  };
  for (const event of events) {
    const previous = group.at(-1);
    if (previous && Date.parse(event.viewed_at) - Date.parse(previous.viewed_at) > gapMinutes * 60_000) flush();
    group.push(event);
  }
  flush();
  return archiveDb.prepare("SELECT * FROM watch_session WHERE owner_id = ? ORDER BY started_at").all(ownerId);
}

function fact<T>(value: T, status: AnalyticsFact<T>["epistemicStatus"], ownerId: string, eventIds?: number[]): AnalyticsFact<T> {
  const c = coverage(ownerId);
  return { value, epistemicStatus: status, provenance: { source: "Archive Assistant normalized watch_event", observedAt: new Date().toISOString(),
    coverage: c?.historical_coverage_start ? `Plex history from ${c.historical_coverage_start}` : undefined, eventIds } };
}

export function getAnalytics(ownerId: string) {
  resolveOwnership(ownerId);
  const rows = archiveDb.prepare("SELECT * FROM watch_event WHERE owner_id = ? ORDER BY viewed_at DESC").all(ownerId) as any[];
  const c = coverage(ownerId);
  const ids = rows.map((x) => x.id);
  const months = new Map<string, number>();
  for (const row of rows) { const month = row.viewed_at.slice(0, 7); months.set(month, (months.get(month) ?? 0) + 1); }
  const unique = new Set(rows.map((x) => x.media_identity)).size;
  const rewatches = Math.max(0, rows.length - unique);
  const owned = rows.filter((x) => x.ownership_resolution === "currently_owned").length;
  const notOwned = rows.length - owned;
  const movies = rows.filter((x) => x.media_type === "movie").length;
  const hasObservedPlaybackDuration = rows.length > 0 && rows.every((x) => x.duration_semantics === "observed_playback");
  const hours = hasObservedPlaybackDuration
    ? rows.reduce((n, x) => n + x.duration_observed_seconds, 0) / 3600 : null;
  const durationEvidence = rows.length === 0 ? "unknown"
    : rows.every((x) => x.duration_semantics === "provider_reported") ? "provider_reported_media_duration"
      : rows.some((x) => x.duration_semantics === "estimated") ? "estimated"
        : hasObservedPlaybackDuration ? "observed_playback_duration" : "mixed_or_unknown";
  const topWatchedMedia = Object.entries(rows.reduce((a, x) => {
    a[x.title] = (a[x.title] ?? 0) + 1;
    return a;
  }, {} as Record<string, number>) as Record<string, number>)
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([title, plays]) => ({ title, plays }));
  return {
    coverage: { historicalCoverageStart: c?.historical_coverage_start ?? null, collectingSince: c?.collecting_since ?? null,
      lastSuccessfulIngestion: c?.last_successful_ingestion ?? null,
      provenance: { source: "Plex history ingestion metadata", status: c ? "observed" : "unknown" } },
    totalPlays: fact(rows.length, "observed", ownerId, ids),
    uniqueTitlesWatched: fact(unique, "derived", ownerId, ids),
    rewatches: fact(rewatches, "derived", ownerId, ids),
    playsByMonth: fact(Object.fromEntries(months), "derived", ownerId, ids),
    hoursWatched: { ...fact(hours, hours == null ? "unknown" : "observed", ownerId, ids), durationEvidence },
    movieTvSplit: fact({ movies, tvEpisodes: rows.length - movies }, "derived", ownerId, ids),
    ownership: fact({ currentlyOwned: owned, notCurrentlyOwned: notOwned,
      previouslyOwned: rows.filter((x) => x.ownership_resolution === "previously_owned").length,
      departureUnconfirmed: rows.filter((x) => x.ownership_resolution === "departure_unconfirmed").length,
      neverMatched: rows.filter((x) => x.ownership_resolution === "never_matched").length },  "derived", ownerId, ids),
    topWatchedMedia: fact(topWatchedMedia, "derived", ownerId, ids),
    recentWatches: rows.slice(0, 20).map((x) => ({ title: x.title, mediaIdentity: x.media_identity, viewedAt: x.viewed_at,
      ownershipResolution: x.ownership_resolution, provenance: { source: x.source, eventId: x.id, provider: x.provider } })),
    sessionMetrics: { status: c?.collecting_since ? "coverage-limited" : "unknown", collectingSince: c?.collecting_since ?? null,
      note: "Completion, abandonment, and average session length are not backfilled from history." },
  };
}
