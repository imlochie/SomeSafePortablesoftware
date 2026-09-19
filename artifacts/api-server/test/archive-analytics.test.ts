import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, describe, test } from "node:test";
import { archiveDb, writeUserSetting } from "../src/lib/archive-db";
import { deriveSessions, getAnalytics, ingestWatchEvents, recordConfirmedArchiveDeparture, resolveOwnership } from "../src/services/archive-analytics";
import { deriveBehavioralSignals, getPersonalisationContext, recordExplicitPreference } from "../src/services/behavioral-intelligence";
import { ingestPlexHistoryFromApi } from "../src/services/archive-analytics";
import { runtimeConfig } from "../src/lib/runtime-config";
import { GetArchivePersonalisationContextResponse } from "@workspace/api-zod";
import type { BehavioralSignal } from "@workspace/api-zod";

after(() => archiveDb.close());
const owner = `${runtimeConfig.localOwnerId}-analytics`;

function event(id: string, identity: string, viewedAt: string) {
  return { providerEventId: id, mediaIdentity: identity, mediaType: "movie" as const, title: identity, viewedAt,
    durationObservedSeconds: 3600, accountId: "primary", scopeIdentity: "plex:default" };
}

describe("archive analytics observation foundation", () => {
  test("is idempotent, preserves ownership epistemics, and rebuilds sessions", () => {
    archiveDb.prepare("INSERT OR IGNORE INTO plex_library (id, name, server_url, owner_id) VALUES (99, 'Analytics', 'http://plex', ?)").run(owner);
    archiveDb.prepare("INSERT OR IGNORE INTO plex_item (library_id, rating_key, title, item_type, owner_id) VALUES (99, 'owned-film', 'owned-film', 'movie', ?)").run(owner);
    ingestWatchEvents(owner, [event("play-1", "owned-film", "2019-04-17T10:00:00.000Z"), event("play-2", "owned-film", "2019-04-17T11:00:00.000Z")],
      { historicalCoverageStart: "2019-04-17", collectingSince: "2026-09-19", accountId: "primary" });
    ingestWatchEvents(owner, [event("play-1", "owned-film", "2019-04-17T10:00:00.000Z")], { accountId: "primary" });
    assert.equal((archiveDb.prepare("SELECT COUNT(*) AS n FROM watch_event WHERE owner_id = ?").get(owner) as any).n, 2);
    const persisted = archiveDb.prepare("SELECT historical_coverage_start, collecting_since, provenance_json, evidence_key, ingestion_id, viewed_at, observed_at, owner_id, scope_identity FROM watch_event WHERE owner_id = ? LIMIT 1").get(owner) as any;
    assert.equal(persisted.historical_coverage_start, "2019-04-17");
    assert.ok(persisted.evidence_key);
    assert.equal(persisted.ingestion_id.startsWith("manual-"), true);
    assert.equal(persisted.owner_id, owner);
    assert.equal(persisted.scope_identity, "plex:default");
    assert.equal(JSON.parse(persisted.provenance_json).eventOccurredAt, persisted.viewed_at);
    assert.equal(JSON.parse(persisted.provenance_json).observedAt, persisted.observed_at);
    assert.notEqual(persisted.viewed_at, persisted.observed_at);
    assert.equal(persisted.collecting_since, "2026-09-19");
    assert.equal((archiveDb.prepare("SELECT duration_semantics FROM watch_event WHERE owner_id = ? LIMIT 1").get(owner) as any).duration_semantics, "provider_reported");
    assert.equal(JSON.parse(persisted.provenance_json).provider, "plex");
    assert.equal((archiveDb.prepare("PRAGMA table_info(watch_event)").all() as any[]).some((column) => column.name === "completed"), false);

    archiveDb.prepare("DELETE FROM plex_item WHERE owner_id = ? AND rating_key = 'owned-film'").run(owner);
    resolveOwnership(owner);
    assert.equal((archiveDb.prepare("SELECT ownership_resolution FROM watch_event WHERE owner_id = ? LIMIT 1").get(owner) as any).ownership_resolution, "departure_unconfirmed");
    recordConfirmedArchiveDeparture(owner, "owned-film", { operation: "archive_operation/delete", operationId: "test-delete" });
    assert.equal((archiveDb.prepare("SELECT ownership_resolution FROM watch_event WHERE owner_id = ? LIMIT 1").get(owner) as any).ownership_resolution, "previously_owned");

    ingestWatchEvents(owner, [event("never-1", "never-matched", "2019-05-01T10:00:00.000Z")], { accountId: "primary" });
    assert.equal((archiveDb.prepare("SELECT ownership_resolution FROM watch_event WHERE owner_id = ? AND media_identity = 'never-matched'").get(owner) as any).ownership_resolution, "never_matched");
    const first = deriveSessions(owner);
    const second = deriveSessions(owner);
    assert.deepEqual(first.map((x: any) => [x.started_at, x.ended_at, x.event_count]), second.map((x: any) => [x.started_at, x.ended_at, x.event_count]));
    const analytics = getAnalytics(owner) as any;
    assert.equal(analytics.coverage.historicalCoverageStart, "2019-04-17");
    assert.equal(analytics.sessionMetrics.status, "coverage-limited");
    assert.equal(analytics.ownership.value.previouslyOwned, 2);
    assert.equal(analytics.ownership.value.neverMatched, 1);
  });

  test("requires provenance-complete observation admission", () => {
    assert.throws(() => ingestWatchEvents(owner, [{ ...event("missing-scope", "scope-required", "2026-09-01T10:00:00.000Z"), scopeIdentity: undefined }]), /scope/i);
    assert.throws(() => ingestWatchEvents(owner, [{ ...event("", "missing-provider-id", "2026-09-01T10:00:00.000Z") }]), /provider event identity/i);
    assert.throws(() => ingestWatchEvents(owner, [{ ...event("missing-time", "missing-time", "not-a-date") }]), /event time/i);
    assert.throws(() => ingestWatchEvents(owner, [{ ...event("missing-batch", "missing-batch", "2026-09-01T10:00:00.000Z") }], { ingestionId: "not-a-durable-batch" }), /durable watch ingestion batch/i);
    const rows = archiveDb.prepare("SELECT evidence_key, provider, scope_identity FROM watch_event WHERE owner_id = ? AND media_identity IN ('scope-required', 'missing-provider-id', 'missing-time', 'missing-batch')").all(owner) as any[];
    assert.equal(rows.length, 0);
  });

  test("rejects out-of-scope, live, DVR, unsupported, and ineligible observations", () => {
    archiveDb.prepare(`INSERT INTO watch_ingestion_batch
      (id, owner_id, provider, scope_identity, started_at, status, completeness, request_context_json)
      VALUES ('scope-refresh-1', ?, 'plex', 'plex:movies-v1', CURRENT_TIMESTAMP, 'running', 'partial', '{}')`).run(owner);
    ingestWatchEvents(owner, [
      { ...event("accepted-scope", "scope-film", "2026-09-01T10:00:00.000Z"), scopeIdentity: "plex:movies-v1", libraryIdentity: "movies" },
      { ...event("wrong-scope", "wrong-scope", "2026-09-01T10:00:00.000Z"), scopeIdentity: "plex:tv-v1", libraryIdentity: "tv" },
      { ...event("live-event", "live-film", "2026-09-01T10:00:00.000Z"), eventType: "live" },
      { ...event("dvr-event", "dvr-film", "2026-09-01T10:00:00.000Z"), eventType: "dvr" },
      { ...event("unknown-event", "unknown-media", "2026-09-01T10:00:00.000Z"), mediaType: "unknown" },
      { ...event("shared-event", "shared-film", "2026-09-01T10:00:00.000Z"), accountEligible: false },
    ], { scope: { identity: "plex:movies-v1", allowedMediaTypes: ["movie"], allowedLibraries: ["movies"] }, ingestionId: "scope-refresh-1" });
    const rows = archiveDb.prepare("SELECT * FROM watch_event WHERE owner_id = ? AND provider_event_id LIKE '%scope%' OR owner_id = ? AND provider_event_id LIKE '%event%'").all(owner, owner) as any[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope_identity, "plex:movies-v1");
    assert.equal(rows[0].ingestion_id, "scope-refresh-1");
  });

  test("ingests paginated Plex history into a durable batch and repeats idempotently", async () => {
    const apiOwner = `${owner}-plex-api`;
    const server = createServer((request, response) => {
      if (!request.url?.startsWith("/status/sessions/history")) { response.writeHead(404).end(); return; }
      const start = new URL(request.url, "http://127.0.0.1").searchParams.get("X-Plex-Container-Start");
      const metadata = start === "0"
        ? [{ historyKey: "plex-history-1", ratingKey: "api-film-1", title: "API Film 1", type: "movie", viewedAt: 1720000000 }]
        : [{ historyKey: "plex-history-2", ratingKey: "api-film-2", title: "API Film 2", type: "movie", viewedAt: 1710000000 }];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ MediaContainer: { size: 1, totalSize: 2, Metadata: metadata } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    writeUserSetting(apiOwner, "plexServerUrl", `http://127.0.0.1:${address.port}`);
    writeUserSetting(apiOwner, "plexToken", "test-token");
    const options = { scope: { identity: "plex:history-v1", allowedMediaTypes: ["movie"] as Array<"movie"> }, historicalCoverageStart: "2024-03-09", collectingSince: "2026-09-19", pageSize: 1 };
    const first = await ingestPlexHistoryFromApi(apiOwner, options);
    const second = await ingestPlexHistoryFromApi(apiOwner, options);
    assert.equal(first.status, "complete");
    assert.equal(first.pages, 2);
    assert.equal(first.inserted, 2);
    assert.equal(second.inserted, 0);
    assert.equal((archiveDb.prepare("SELECT COUNT(*) AS n FROM watch_event WHERE owner_id = ?").get(apiOwner) as any).n, 2);
    assert.equal(second.status, "empty_authoritative");
    assert.equal((archiveDb.prepare("SELECT COUNT(*) AS n FROM watch_ingestion_batch WHERE owner_id = ? AND status = 'complete'").get(apiOwner) as any).n, 1);
    assert.equal((archiveDb.prepare("SELECT COUNT(*) AS n FROM watch_ingestion_batch WHERE owner_id = ? AND status = 'empty_authoritative'").get(apiOwner) as any).n, 1);
    assert.equal((archiveDb.prepare("SELECT last_successful_ingestion FROM analytics_coverage WHERE owner_id = ? AND provider = 'plex'").get(apiOwner) as any) !== undefined, true);
    const apiSignals = deriveBehavioralSignals(apiOwner, new Date("2026-09-19T00:00:00.000Z")) as any[];
    assert.ok(apiSignals.length > 0);
    assert.ok(apiSignals.every((signal) => signal.provenance.batchIds.includes(first.batchId)));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  test("records a later-page failure as partial without advancing successful coverage", async () => {
    const apiOwner = `${owner}-plex-partial`;
    const server = createServer((request, response) => {
      const start = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("X-Plex-Container-Start");
      if (start !== "0") { response.writeHead(502).end("upstream failure"); return; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ MediaContainer: { totalSize: 2, Metadata: [{ historyKey: "partial-1", ratingKey: "partial-film", title: "Partial Film", type: "movie", viewedAt: 1720000000 }] } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    writeUserSetting(apiOwner, "plexServerUrl", `http://127.0.0.1:${address.port}`);
    writeUserSetting(apiOwner, "plexToken", "test-token");
    ingestWatchEvents(apiOwner, [], { scope: { identity: "plex:default" }, historicalCoverageStart: "2019-04-17", collectingSince: "2026-09-19" });
    const before = (archiveDb.prepare("SELECT last_successful_ingestion FROM analytics_coverage WHERE owner_id = ?").get(apiOwner) as any).last_successful_ingestion;
    const result = await ingestPlexHistoryFromApi(apiOwner, { scope: { identity: "plex:partial-v1", allowedMediaTypes: ["movie"] as Array<"movie"> }, historicalCoverageStart: "2019-04-17", collectingSince: "2026-09-19", pageSize: 1 });
    assert.equal(result.status, "partial");
    assert.equal((archiveDb.prepare("SELECT last_successful_ingestion FROM analytics_coverage WHERE owner_id = ?").get(apiOwner) as any).last_successful_ingestion, before);
    assert.equal((archiveDb.prepare("SELECT completeness FROM watch_ingestion_batch WHERE id = ?").get(result.batchId) as any).completeness, "partial");
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  test("rebuilds explainable recent, long-term, rewatch, scope, and explicit signals", () => {
    const scope = "plex:movies-v1";
    ingestWatchEvents(owner, [
      { ...event("behaviour-old", "behaviour-film", "2020-01-01T10:00:00.000Z"), scopeIdentity: scope },
      { ...event("behaviour-previous", "behaviour-film", "2026-05-01T10:00:00.000Z"), scopeIdentity: scope },
      { ...event("behaviour-new-1", "behaviour-film", "2026-08-01T10:00:00.000Z"), scopeIdentity: scope },
      { ...event("behaviour-new-2", "behaviour-film", "2026-09-01T10:00:00.000Z"), scopeIdentity: scope },
    ], { scopeIdentity: scope, collectingSince: "2026-09-19" });
    const signals = deriveBehavioralSignals(owner, new Date("2026-09-19T00:00:00.000Z"));
    const recent = signals.find((x: any) => x.signalType === "recent_activity" && x.subjectIdentity === "behaviour-film") as any;
    const previous = signals.find((x: any) => x.signalType === "recent_activity_previous" && x.subjectIdentity === "behaviour-film") as any;
    const temporalRows = signals.filter((x: any) => x.subjectIdentity === "behaviour-film" && ["recent_activity", "recent_activity_previous"].includes(x.signalType));
    const rewatch = signals.find((x: any) => x.signalType === "rewatch_affinity" && x.subjectIdentity === "behaviour-film") as any;
    assert.equal(recent.scopeIdentity, scope);
    assert.equal(temporalRows.length, 2);
    assert.equal(recent.value.watches, 2);
    assert.equal(previous.value.watches, 1);
    assert.equal(recent.value.watchesLast90Days, 2);
    assert.deepEqual(recent.value.window, {
      startsAt: "2026-06-21T00:00:00.000Z",
      endsAt: "2026-09-19T00:00:00.000Z",
    });
    assert.deepEqual(previous.value.window, {
      startsAt: "2026-03-23T00:00:00.000Z",
      endsAt: "2026-06-21T00:00:00.000Z",
    });
    assert.equal(recent.value.watchesPrevious90Days, 1);
    assert.equal(recent.derivedAt, "2026-09-19T00:00:00.000Z");
    assert.equal(previous.derivedAt, recent.derivedAt);
    assert.equal(previous.value.window.endsAt, recent.value.window.startsAt);
    assert.ok(previous.value.window.endsAt <= recent.value.window.startsAt);
    assert.equal(rewatch.value.rewatchCount, 3);
    assert.equal(rewatch.coverage.collectingSince, "2026-09-19");
    assert.ok(typeof recent.signalId === "string");
    assert.ok(Array.isArray(recent.provenance.eventIds));
    assert.ok(Array.isArray(recent.provenance.observationIds));
    assert.ok(Array.isArray(recent.provenance.evidenceKeys));
    assert.ok(Array.isArray(recent.provenance.providerEventIds));
    assert.ok(Array.isArray(recent.provenance.ingestionBatchIds));
    assert.ok(Array.isArray(recent.provenance.eventOccurredAt));
    assert.ok(Array.isArray(recent.provenance.observedAt));
    for (const row of [recent, previous]) {
      assert.equal(row.epistemicStatus, "derived");
      assert.ok(typeof row.signalId === "string");
      for (const key of ["observationIds", "evidenceKeys", "providerEventIds", "ingestionBatchIds", "batchIds", "eventOccurredAt", "observedAt", "scopeIdentity"]) {
        assert.ok(key in row.provenance);
      }
      assert.ok(row.provenance.eventIds.length > 0);
    }
    recordExplicitPreference(owner, { scopeIdentity: scope, subjectType: "genre", subjectIdentity: "Japanese cinema", statement: "I am into Japanese cinema right now.", observedAt: "2026-09-18T12:00:00.000Z" });
    const persistedPreference = archiveDb.prepare("SELECT id, owner_id, scope_identity, observed_at, provenance_json FROM explicit_preference WHERE owner_id = ? ORDER BY id DESC LIMIT 1").get(owner) as any;
    const context = getPersonalisationContext(owner) as any;
    const preference = context.explicitPreferences.find((item: any) => item.subjectIdentity === "Japanese cinema");
    assert.equal(preference.preferenceId, persistedPreference.id);
    assert.equal(preference.provenanceStatus, "authoritative");
    assert.deepEqual(preference.provenance, {
      preferenceId: persistedPreference.id, source: "operator_statement", observedAt: persistedPreference.observed_at, scopeIdentity: scope,
    });
    assert.equal(preference.observedAt, persistedPreference.observed_at);
    assert.equal(preference.scopeIdentity, persistedPreference.scope_identity);
    assert.equal(preference.statement, "I am into Japanese cinema right now.");
    recordExplicitPreference(`${owner}-other`, { scopeIdentity: scope, subjectType: "genre", subjectIdentity: "Other owner preference", statement: "Other owner statement" });
    assert.equal((getPersonalisationContext(owner) as any).explicitPreferences.some((item: any) => item.subjectIdentity === "Other owner preference"), false);
    archiveDb.prepare(`INSERT INTO explicit_preference
      (owner_id, scope_identity, subject_type, subject_identity, statement, observed_at, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(owner, scope, "genre", "legacy preference", "Legacy statement", "2020-01-01T00:00:00.000Z", JSON.stringify({ source: "operator statement" }));
    const legacy = (getPersonalisationContext(owner) as any).explicitPreferences.find((item: any) => item.subjectIdentity === "legacy preference");
    assert.equal(legacy.provenanceStatus, "legacy");
    assert.equal(legacy.provenance, null);
    assert.ok(context.facts.length > 0);
    assert.ok(context.observedSignals.every((signal: any) => signal.evidenceClass === "observed_signal"));
    assert.ok(context.temporalSignals.every((signal: any) => signal.evidenceClass === "temporal_signal"));
    assert.ok(context.collectionFacts.every((signal: any) => signal.evidenceClass === "collection_fact"));
    assert.deepEqual(context.interpretations, []);
    assert.deepEqual(context.uncertainties, []);
    assert.ok(context.temporalSignals.every((signal: any) => signal.provenance.eventIds.length > 0));
    const parsed = GetArchivePersonalisationContextResponse.parse(context);
    const typedSignal: BehavioralSignal = parsed.temporalSignals[0];
    assert.equal(typedSignal.derivedAt, parsed.temporalSignals[0].derivedAt);
    assert.equal(typedSignal.derivedAt, context.temporalSignals[0].derivedAt);
    assert.deepEqual(parsed.temporalSignals[0].provenance, context.temporalSignals[0].provenance);
    for (const key of ["observationIds", "evidenceKeys", "providerEventIds", "ingestionBatchIds", "eventOccurredAt", "observedAt", "scopeIdentity"]) {
      assert.ok(key in parsed.temporalSignals[0].provenance);
    }
    assert.equal("personalAffinity" in parsed, false);
    assert.equal("personalizedBriefing" in parsed, false);
    assert.deepEqual(parsed.interpretations, []);
    assert.deepEqual(parsed.uncertainties, []);
  });
});
