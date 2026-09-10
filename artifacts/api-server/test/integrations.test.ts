import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDefaultIntegrationRegistry,
  createPlexAdapter,
  IntegrationRegistry,
  IntegrationUnavailableError,
} from "../src/integrations";
import { addEvent, archiveDb, pruneSystemEvents, readEvents } from "../src/lib/archive-db";
import {
  getWebhookDeliveryDiagnostics,
  readWebhookSecretCandidates,
  readWebhookSecretStatus,
  recordWebhookDelivery,
  rotateWebhookSecret,
} from "../src/services/settings";

describe("integration adapter foundation", () => {
  test("registry rejects duplicate adapter IDs", () => {
    const adapter = createPlexAdapter();
    assert.throws(
      () => new IntegrationRegistry([adapter, adapter]),
      /duplicate adapter IDs/i,
    );
  });

  test("default registry resolves every known integration and reports unconfigured adapters as disconnected", async () => {
    const registry = createDefaultIntegrationRegistry({});
    const statuses = await registry.getStatuses("__local__");
    assert.deepEqual(
      statuses.map((status) => status.id),
      ["plex", "sonarr", "radarr", "prowlarr", "qbittorrent", "mpilot", "telegram"],
    );

    const sonarr = statuses.find((status) => status.id === "sonarr");
    assert.ok(sonarr);
    assert.equal(sonarr.state, "disconnected");
    assert.equal(sonarr.configured, false);
    assert.equal(sonarr.reachable, false);
    assert.equal(sonarr.operational, false);
    assert.match(sonarr.detail, /not configured/i);
  });

  test("disconnected adapters fail explicitly instead of returning mocked capability data", async () => {
    const registry = createDefaultIntegrationRegistry({});
    await assert.rejects(
      registry.invoke(
        "acquisition_job_creation",
        { mediaType: "episode", title: "Example" },
        { ownerId: "__local__" },
        "sonarr",
      ),
      (error: unknown) => {
        assert.ok(error instanceof IntegrationUnavailableError);
        assert.equal(error.integrationId, "sonarr");
        assert.equal(error.capability, "acquisition_job_creation");
        assert.match(error.message, /disconnected/i);
        return true;
      },
    );
  });

  test("Plex is wired through the existing service-backed adapter", () => {
    const adapter = createPlexAdapter();
    assert.equal(adapter.id, "plex");
    assert.deepEqual(adapter.capabilities, [
      "archive_search",
      "media_inspection",
      "media_verification",
      "library_scan",
    ]);
    assert.equal(typeof adapter.getCapability("archive_search"), "function");
    assert.equal(typeof adapter.getCapability("library_scan"), "function");
    assert.equal(adapter.getCapability("rename_move"), undefined);
  });

  test("incompletely configured integrations remain disconnected", async () => {
    const registry = createDefaultIntegrationRegistry({
      SONARR_URL: "http://sonarr.local",
    });
    const sonarr = (await registry.getStatuses("__local__")).find((status) => status.id === "sonarr");
    assert.ok(sonarr);
    assert.equal(sonarr.configured, false);
    assert.equal(sonarr.state, "disconnected");
    assert.equal(sonarr.operational, false);
    assert.match(sonarr.detail, /API key is required/i);
  });

  test("webhook secret rotation supports environment fallback, overlap, expiry, and cutover", () => {
    const key = "integration.webhook.sonarr";
    archiveDb.prepare("DELETE FROM setting WHERE key = ?").run(key);
    const env = { SONARR_WEBHOOK_SECRET: "environment-secret-1234" } as NodeJS.ProcessEnv;
    const firstNow = Date.parse("2026-09-10T12:00:00.000Z");

    try {
      assert.equal(readWebhookSecretStatus("sonarr", env, firstNow).configured, true);
      const overlapped = rotateWebhookSecret(
        "sonarr",
        { secret: "replacement-secret-1234", mode: "overlap", overlapMinutes: 30 },
        env,
        firstNow,
      );
      assert.equal(overlapped.configured, true);
      assert.equal(overlapped.overlapUntil, "2026-09-10T12:30:00.000Z");
      assert.deepEqual(
        readWebhookSecretCandidates("sonarr", env, firstNow),
        ["replacement-secret-1234", "environment-secret-1234"],
      );
      assert.deepEqual(
        readWebhookSecretCandidates("sonarr", env, Date.parse("2026-09-10T12:30:00.000Z")),
        ["replacement-secret-1234"],
      );

      const cutover = rotateWebhookSecret(
        "sonarr",
        { secret: "final-secret-123456", mode: "cutover" },
        env,
        firstNow,
      );
      assert.equal(cutover.overlapUntil, null);
      assert.deepEqual(readWebhookSecretCandidates("sonarr", env, firstNow), ["final-secret-123456"]);
      assert.throws(
        () => rotateWebhookSecret("sonarr", { secret: "too-short", mode: "cutover" }, env, firstNow),
        /at least 16 characters/i,
      );
    } finally {
      archiveDb.prepare("DELETE FROM setting WHERE key = ?").run(key);
    }
  });

  test("successful webhook rotations create a redacted owner-scoped audit event", () => {
    const settingKey = "integration.webhook.radarr";
    const ownerId = "rotation-audit-owner";
    const secret = "audit-secret-123456";
    const now = Date.parse("2026-09-10T13:00:00.000Z");
    archiveDb.prepare("DELETE FROM setting WHERE key = ?").run(settingKey);
    archiveDb.prepare("DELETE FROM system_event WHERE owner_id = ?").run(ownerId);

    try {
      rotateWebhookSecret(
        "radarr",
        { secret, mode: "overlap", overlapMinutes: 45 },
        {},
        now,
        { ownerId, operatorId: "operator-42" },
      );

      const [event] = readEvents(ownerId);
      assert.ok(event);
      assert.equal(event.level, "success");
      assert.equal(event.source, "integrations");
      assert.equal(event.operatorId, "operator-42");
      assert.equal(event.retentionClass, "security");
      assert.equal(event.timestamp, "2026-09-10T13:00:00.000Z");
      assert.match(event.message, /radarr/i);
      assert.match(event.message, /overlap/i);
      assert.doesNotMatch(JSON.stringify(event), new RegExp(secret));
    } finally {
      archiveDb.prepare("DELETE FROM setting WHERE key = ?").run(settingKey);
      archiveDb.prepare("DELETE FROM system_event WHERE owner_id = ?").run(ownerId);
    }
  });

  test("event retention prunes only aged operational history for the requested owner", () => {
    const ownerA = "retention-owner-a";
    const ownerB = "retention-owner-b";
    const now = Date.parse("2026-09-10T15:00:00.000Z");
    const old = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();

    archiveDb.prepare("DELETE FROM system_event WHERE owner_id IN (?, ?)").run(ownerA, ownerB);
    try {
      addEvent("info", "Old operational A", "retention-test", ownerA, null, old);
      addEvent("info", "Old operational B", "retention-test", ownerB, null, old);
      addEvent("info", "Recent operational A", "retention-test", ownerA, null, recent);
      addEvent("success", "Webhook secret rotated for sonarr using cutover mode.", "integrations", ownerA, "operator-a", old, "security");

      assert.equal(pruneSystemEvents(ownerA, now), 1);
      const eventsA = readEvents(ownerA, 20);
      const eventsB = readEvents(ownerB, 20);
      assert.ok(!eventsA.some((event) => event.message === "Old operational A"));
      assert.ok(eventsA.some((event) => event.message === "Recent operational A"));
      assert.ok(eventsA.some((event) => event.message.includes("Webhook secret rotated")));
      assert.ok(eventsB.some((event) => event.message === "Old operational B"));
    } finally {
      archiveDb.prepare("DELETE FROM system_event WHERE owner_id IN (?, ?)").run(ownerA, ownerB);
    }
  });

  test("invalid webhook rotation attempts do not create audit events", () => {
    const settingKey = "integration.webhook.radarr";
    const ownerId = "rotation-validation-owner";
    const now = Date.parse("2026-09-10T14:00:00.000Z");
    archiveDb.prepare("DELETE FROM setting WHERE key = ?").run(settingKey);
    archiveDb.prepare("DELETE FROM system_event WHERE owner_id = ?").run(ownerId);

    try {
      assert.throws(
        () => rotateWebhookSecret(
          "radarr",
          { secret: "too-short", mode: "cutover" },
          {},
          now,
          { ownerId, operatorId: "operator-42" },
        ),
        /at least 16 characters/i,
      );
      assert.deepEqual(readEvents(ownerId), []);
    } finally {
      archiveDb.prepare("DELETE FROM setting WHERE key = ?").run(settingKey);
      archiveDb.prepare("DELETE FROM system_event WHERE owner_id = ?").run(ownerId);
    }
  });

  test("webhook delivery diagnostics keep redacted rolling result counts", () => {
    const key = "integration.webhook.sonarr.diagnostics";
    archiveDb.prepare("DELETE FROM setting WHERE key = ?").run(key);
    const firstNow = Date.parse("2026-09-10T12:00:00.000Z");

    try {
      recordWebhookDelivery("sonarr", "accepted", firstNow);
      recordWebhookDelivery("sonarr", "accepted", firstNow + 1_000);
      recordWebhookDelivery("sonarr", "rejected", firstNow + 2_000);
      recordWebhookDelivery("sonarr", "unavailable", firstNow + 3_000);
      recordWebhookDelivery("sonarr", "malformed", firstNow + 4_000);

      const diagnostics = getWebhookDeliveryDiagnostics("sonarr", firstNow + 5_000);
      assert.deepEqual(diagnostics.counts, {
        accepted: 2,
        rejected: 1,
        unavailable: 1,
        malformed: 1,
      });
      assert.equal(diagnostics.lastResult, "malformed");
      assert.equal(diagnostics.lastReceivedAt, "2026-09-10T12:00:04.000Z");

      const row = archiveDb.prepare("SELECT value FROM setting WHERE key = ?").get(key) as { value: string };
      assert.doesNotMatch(row.value, /request-body|signature|secret/i);

      const expired = getWebhookDeliveryDiagnostics("sonarr", firstNow + 24 * 60 * 60 * 1000 + 1);
      assert.deepEqual(expired.counts, {
        accepted: 0,
        rejected: 0,
        unavailable: 0,
        malformed: 0,
      });
      assert.equal(expired.lastResult, null);
      assert.equal(expired.lastReceivedAt, null);
    } finally {
      archiveDb.prepare("DELETE FROM setting WHERE key = ?").run(key);
    }
  });
});