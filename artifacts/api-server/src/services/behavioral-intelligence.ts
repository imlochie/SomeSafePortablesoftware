import { archiveDb } from "../lib/archive-db";
import { getAnalytics } from "./archive-analytics";

export type BehavioralProfile = "long_term" | "recent" | "collection";
export type BehavioralSignalType = "recent_activity" | "recent_activity_previous" | "long_term_affinity" | "rewatch_affinity" | "collection_relationship";

type EventRow = {
  id: number; scope_identity: string; media_identity: string; title: string; viewed_at: string; observed_at: string;
  ownership_resolution: string; provider: string; provider_event_id: string; evidence_key: string | null; ingestion_id: string | null; provenance_json: string;
};

function coverageFor(ownerId: string) {
  const row = archiveDb.prepare("SELECT * FROM analytics_coverage WHERE owner_id = ? AND provider = 'plex'").get(ownerId) as any;
  return {
    historicalCoverageStart: row?.historical_coverage_start ?? null,
    collectingSince: row?.collecting_since ?? null,
    source: "Archive Assistant analytics coverage",
  };
}

function insertSignal(ownerId: string, scope: string, profile: BehavioralProfile, signalType: BehavioralSignalType,
  subject: string, value: unknown, events: EventRow[], coverage: unknown, derivedAt: string) {
  const eventIds = events.map((event) => event.id);
  const providerEventIds = events.map((event) => event.provider_event_id);
  const evidenceKeys = events.map((event) => event.evidence_key).filter((key): key is string => Boolean(key));
  const batchIds = [...new Set(events.map((event) => event.ingestion_id).filter((id): id is string => Boolean(id)))];
  const eventOccurredAt = events.map((event) => event.viewed_at);
  const observedAt = events.map((event) => event.observed_at);
  archiveDb.prepare(`INSERT INTO behavioral_signal
    (owner_id, scope_identity, profile, signal_type, subject_type, subject_identity, value_json,
     epistemic_status, coverage_json, provenance_json, derived_at)
    VALUES (?, ?, ?, ?, 'media', ?, ?, 'derived', ?, ?, ?)
    ON CONFLICT(owner_id, scope_identity, profile, signal_type, subject_type, subject_identity)
    DO UPDATE SET value_json=excluded.value_json, coverage_json=excluded.coverage_json,
      provenance_json=excluded.provenance_json, derived_at=excluded.derived_at`)
    .run(ownerId, scope, profile, signalType, subject, JSON.stringify(value), JSON.stringify(coverage),
      JSON.stringify({ derivedFrom: "watch_event", observationIds: eventIds, eventIds, evidenceKeys, providerEventIds,
        ingestionBatchIds: batchIds, batchIds, eventOccurredAt, observedAt, scopeIdentity: scope }), derivedAt);
}

/** Rebuilds all supported behavioral facts from canonical watch events. No recommendation score is produced. */
export function deriveBehavioralSignals(ownerId: string, now = new Date()) {
  const events = archiveDb.prepare(`SELECT id, scope_identity, media_identity, title, viewed_at, observed_at, ownership_resolution,
    provider, provider_event_id, evidence_key, ingestion_id, provenance_json
    FROM watch_event
    WHERE owner_id = ? AND evidence_key IS NOT NULL AND ingestion_id IS NOT NULL
      AND scope_identity IS NOT NULL AND viewed_at IS NOT NULL AND observed_at IS NOT NULL
    ORDER BY viewed_at, id`).all(ownerId) as EventRow[];
  const scopes = new Set(events.map((event) => event.scope_identity));
  archiveDb.prepare("DELETE FROM behavioral_signal WHERE owner_id = ?").run(ownerId);
  const coverage = coverageFor(ownerId);
  for (const scope of scopes) {
    const scoped = events.filter((event) => event.scope_identity === scope);
    const subjects = new Map<string, EventRow[]>();
    for (const event of scoped) subjects.set(event.media_identity, [...(subjects.get(event.media_identity) ?? []), event]);
    for (const [subject, watches] of subjects) {
      const timestamps = watches.map((event) => Date.parse(event.viewed_at)).filter(Number.isFinite);
      const windowEndsAt = now.toISOString();
      const recent30StartsAt = new Date(now.getTime() - 30 * 86400000).toISOString();
      const recent90StartsAt = new Date(now.getTime() - 90 * 86400000).toISOString();
      const previous90StartsAt = new Date(now.getTime() - 180 * 86400000).toISOString();
      const recent30 = watches.filter((event) => event.viewed_at >= recent30StartsAt && event.viewed_at <= windowEndsAt);
      const recent90 = watches.filter((event) => event.viewed_at >= recent90StartsAt && event.viewed_at <= windowEndsAt);
      const previous90 = watches.filter((event) => event.viewed_at >= previous90StartsAt && event.viewed_at < recent90StartsAt);
      const repeatCount = Math.max(0, watches.length - 1);
      const intervals = timestamps.slice(1).map((time, index) => Math.round((time - timestamps[index]) / 86400000));
      insertSignal(ownerId, scope, "long_term", "long_term_affinity", subject, {
        title: watches.at(-1)?.title, totalWatches: watches.length, firstWatchedAt: new Date(Math.min(...timestamps)).toISOString(),
        lastWatchedAt: new Date(Math.max(...timestamps)).toISOString(), activeMonths: new Set(watches.map((e) => e.viewed_at.slice(0, 7))).size,
      }, watches, coverage, now.toISOString());
      if (recent90.length > 0) insertSignal(ownerId, scope, "recent", "recent_activity", subject, {
        title: watches.at(-1)?.title, watches: recent90.length,
        watchesLast30Days: recent30.length, watchesLast90Days: recent90.length,
        watchesPrevious90Days: previous90.length,
        lastWatchedAt: new Date(Math.max(...timestamps)).toISOString(), comparisonWindowDays: 90,
        window: { startsAt: recent90StartsAt, endsAt: windowEndsAt },
      }, recent90, coverage, windowEndsAt);
      if (previous90.length > 0) insertSignal(ownerId, scope, "recent", "recent_activity_previous", subject, {
        title: watches.at(-1)?.title, watches: previous90.length,
        window: { startsAt: previous90StartsAt, endsAt: recent90StartsAt },
      }, previous90, coverage, windowEndsAt);
      if (repeatCount > 0) insertSignal(ownerId, scope, "long_term", "rewatch_affinity", subject, {
        title: watches.at(-1)?.title, firstWatch: watches[0].viewed_at, rewatchCount: repeatCount,
        rewatchIntervalsDays: intervals, lastRewatchAt: watches.at(-1)?.viewed_at,
      }, watches, coverage, now.toISOString());
    }
    const relationship = scoped.reduce((result, event) => {
      const key = event.ownership_resolution;
      result[key] = (result[key] ?? 0) + 1;
      return result;
    }, {} as Record<string, number>);
    insertSignal(ownerId, scope, "collection", "collection_relationship", "archive", relationship,
      scoped, coverage, now.toISOString());
  }
  return readBehavioralSignals(ownerId);
}

export function recordExplicitPreference(ownerId: string, input: {
  scopeIdentity: string; subjectType: string; subjectIdentity: string; statement: string;
  observedAt?: string; provenance?: Record<string, unknown>;
}) {
  archiveDb.prepare(`INSERT INTO explicit_preference
    (owner_id, scope_identity, subject_type, subject_identity, statement, observed_at, provenance_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(ownerId, input.scopeIdentity, input.subjectType, input.subjectIdentity, input.statement,
      input.observedAt ?? new Date().toISOString(), JSON.stringify(input.provenance ?? { source: "operator statement" }));
}

export function readBehavioralSignals(ownerId: string) {
  const rows = archiveDb.prepare(`SELECT * FROM behavioral_signal WHERE owner_id = ?
    ORDER BY profile, signal_type, subject_identity`).all(ownerId) as any[];
  return rows.map((row) => ({
    evidenceClass: ["recent_activity", "recent_activity_previous"].includes(row.signal_type) ? "temporal_signal"
      : row.signal_type === "collection_relationship" ? "collection_fact" : "observed_signal",
    signalId: String(row.id), profile: row.profile, signalType: row.signal_type, subjectType: row.subject_type,
    subjectIdentity: row.subject_identity, value: JSON.parse(row.value_json),
    epistemicStatus: row.epistemic_status, scopeIdentity: row.scope_identity,
    coverage: JSON.parse(row.coverage_json), provenance: JSON.parse(row.provenance_json), derivedAt: row.derived_at,
  }));
}

type PersonalisationFact = {
  evidenceClass: "fact";
  factType: string;
  value: unknown;
  epistemicStatus: "observed" | "derived" | "coverage-limited" | "unknown";
  provenance: Record<string, unknown>;
};

/**
 * Exposes the six-class vocabulary without inventing evidence. Analytics facts and
 * derived signals are classified from their existing source rows; interpretations
 * and uncertainties remain empty until a source can establish them.
 */
export function getPersonalisationContext(ownerId: string) {
  const signals = deriveBehavioralSignals(ownerId);
  const analytics = getAnalytics(ownerId) as Record<string, any>;
  const facts: PersonalisationFact[] = Object.entries(analytics)
    .filter(([, value]) => value && typeof value === "object" && "epistemicStatus" in value && "provenance" in value)
    .map(([factType, value]) => ({ evidenceClass: "fact", factType, value: value.value,
      epistemicStatus: value.epistemicStatus, provenance: value.provenance }));
  const explicitPreferences = (archiveDb.prepare("SELECT * FROM explicit_preference WHERE owner_id = ? ORDER BY observed_at DESC").all(ownerId) as any[])
    .map((row) => ({ subjectType: row.subject_type, subjectIdentity: row.subject_identity, statement: row.statement,
      scopeIdentity: row.scope_identity, observedAt: row.observed_at, provenance: JSON.parse(row.provenance_json) }));
  return {
    domain: "archive.personalisation",
    facts,
    observedSignals: signals.filter((signal) => !["recent_activity", "recent_activity_previous", "collection_relationship"].includes(signal.signalType)),
    temporalSignals: signals.filter((signal) => ["recent_activity", "recent_activity_previous"].includes(signal.signalType)),
    collectionFacts: signals.filter((signal) => signal.signalType === "collection_relationship"),
    interpretations: [],
    uncertainties: [],
    explicitPreferences,
    constraints: ["Signals are observations, not likes or preferences", "No universal taste score", "No recommendation decision is made here"],
  };
}
