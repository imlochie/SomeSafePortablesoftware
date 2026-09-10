import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDefaultIntegrationRegistry,
  createPlexAdapter,
  IntegrationRegistry,
  IntegrationUnavailableError,
} from "../src/integrations";
import { archiveDb } from "../src/lib/archive-db";
import {
  readWebhookSecretCandidates,
  readWebhookSecretStatus,
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
});