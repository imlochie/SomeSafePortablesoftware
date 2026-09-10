import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDefaultIntegrationRegistry,
  createPlexAdapter,
  IntegrationRegistry,
  IntegrationUnavailableError,
} from "../src/integrations";

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
});