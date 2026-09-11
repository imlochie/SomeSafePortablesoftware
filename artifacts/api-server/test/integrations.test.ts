import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import express from "express";
import { ListIntegrationsResponse } from "@workspace/api-zod";
import { integrations } from "../src/integrations";
import { IntegrationRegistry } from "../src/integrations/registry";
import { IntegrationService } from "../src/integrations/service";
import { IntegrationError, type CapabilityHandlers, type IntegrationAdapter } from "../src/integrations/contracts";
import { placeholderAdapters } from "../src/integrations/adapters/placeholders";
import { writeUserSetting } from "../src/lib/archive-db";
import { runtimeConfig } from "../src/lib/runtime-config";
import integrationsRouter from "../src/routes/integrations";

function testAdapter(id = "test-provider") {
  const calls: string[] = [];
  const adapter: IntegrationAdapter = {
    id, name: "Test provider", plannedCapabilities: ["search_source"],
    status: () => ({ state: "connected", configured: true, lastSuccessfulSyncAt: null }),
    async testConnection({ ownerId }) {
      calls.push(`connection:${ownerId}`);
      return { state: "connected", configured: true, lastSuccessfulSyncAt: null };
    },
    handlers: {
      async media_host_inventory({ ownerId }) {
        calls.push(`inventory:${ownerId}`);
        return { cached: true, lastSuccessfulSyncAt: null, items: [{ id: "opaque", title: ownerId, kind: "movie", year: null }] };
      },
    },
  };
  return { adapter, calls };
}
const code = (expected: IntegrationError["code"]) => (error: unknown) => error instanceof IntegrationError && error.code === expected;

describe("integration adapter foundation", { concurrency: false }, () => {
  test("registration rejects duplicate/invalid IDs and discovers handlers, not planned capabilities", () => {
    const { adapter } = testAdapter();
    const registry = new IntegrationRegistry().register(adapter);
    assert.throws(() => registry.register(adapter), /duplicate/);
    assert.throws(() => registry.register({ ...adapter, id: "../invalid" }), /Invalid/);
    assert.throws(() => registry.register({ ...adapter, id: "invalid-handler", handlers: { bogus: () => null } } as never), /Invalid capability/);
    assert.throws(() => registry.get("missing"), code("not_found"));
    assert.deepEqual(registry.discover("media_host_inventory").map((item) => item.id), [adapter.id]);
    assert.deepEqual(registry.discover("search_source"), []);
    // Registration takes immutable snapshots of the capability definitions.
    delete (adapter.handlers as CapabilityHandlers).media_host_inventory;
    assert.equal(registry.discover("media_host_inventory").length, 1);
  });

  test("owner isolation covers enablement, discovery, connection, and inventory dispatch", async () => {
    const { adapter, calls } = testAdapter();
    const service = new IntegrationService(new IntegrationRegistry().register(adapter));
    const a = "integration-owner-a", b = "integration-owner-b";
    service.configure(a, adapter.id, { enabled: false });
    assert.equal(service.describe(a, adapter.id).enabled, false);
    assert.equal(service.describe(b, adapter.id).enabled, true);
    assert.deepEqual(service.discover(a, "media_host_inventory"), []);
    assert.equal(service.discover(b, "media_host_inventory").length, 1);
    await service.testConnection(a, adapter.id);
    await assert.rejects(service.execute(a, adapter.id, "media_host_inventory"), code("disabled"));
    assert.deepEqual(calls, []);
    const inventory = await service.execute(b, adapter.id, "media_host_inventory");
    assert.equal(inventory.items[0].title, b);
    await service.testConnection(b, adapter.id);
    assert.deepEqual(calls, [`inventory:${b}`, `connection:${b}`]);
    assert.throws(() => service.list(" "), /Owner/);
    assert.throws(() => service.configure(a, "unknown", { enabled: true }), code("not_found"));
  });

  test("all target integrations are optional, and placeholders never claim implemented capabilities", async () => {
    const owner = "integration-unconfigured";
    const list = ListIntegrationsResponse.parse(integrations.list(owner));
    assert.deepEqual(list.map((item) => item.id), ["plex", "sonarr", "radarr", "prowlarr", "qbittorrent", "mpilot", "telegram"]);
    assert.ok(list.every((item) => !item.enabled && !item.configured && !item.availableCapabilities.length));
    for (const adapter of placeholderAdapters) {
      integrations.configure(owner, adapter.id, { enabled: true });
      const result = await integrations.testConnection(owner, adapter.id);
      assert.equal(result.state, "unavailable");
      assert.deepEqual(result.capabilities, []);
      assert.deepEqual(result.availableCapabilities, []);
      await assert.rejects(integrations.execute(owner, adapter.id, "media_host_inventory"), code("unsupported"));
      await assert.rejects(integrations.execute(owner, adapter.id, "acquisition_request"), code("unsupported"));
    }
    assert.equal((await integrations.testConnection(owner, "plex")).state, "not_configured");
    integrations.configure(owner, "plex", { enabled: true });
    await assert.rejects(integrations.execute(owner, "plex", "media_host_inventory"), code("not_configured"));
  });

  test("disconnected providers expose only cached inventory; transport exceptions are sanitized", async () => {
    const { adapter, calls } = testAdapter("offline-provider");
    adapter.status = () => ({ state: "disconnected", configured: true, lastSuccessfulSyncAt: null });
    const service = new IntegrationService(new IntegrationRegistry().register(adapter));
    assert.equal((await service.execute("offline-owner", adapter.id, "media_host_inventory")).cached, true);
    assert.equal(calls.length, 1);
    const broken = testAdapter("broken-provider").adapter;
    broken.testConnection = async () => { throw new Error("token=secret-provider-detail"); };
    (broken.handlers as CapabilityHandlers).media_host_inventory = async () => { throw new Error("secret-provider-detail"); };
    const brokenService = new IntegrationService(new IntegrationRegistry().register(broken));
    await assert.rejects(brokenService.execute("offline-owner", broken.id, "media_host_inventory"), code("unavailable"));
    await assert.rejects(brokenService.testConnection("offline-owner", broken.id), code("unavailable"));
  });

  test("generic control plane has no provider transport, database tables, or provider-service imports", async () => {
    for (const file of ["src/integrations/contracts.ts", "src/integrations/registry.ts", "src/integrations/service.ts", "src/routes/integrations.ts"]) {
      const source = await readFile(file, "utf8");
      assert.doesNotMatch(source, /services\/plex|plex_item|plex_library|X-Plex-Token|ratingKey|node:http|node:child_process|fetch\(/);
    }
  });

  test("HTTP configuration is strict and owner-scoped; status never exposes credentials", async () => {
    const app = express();
    app.use(express.json());
    // Same owner resolver as production; local mode supplies the local owner.
    app.use("/api", integrationsRouter);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/integrations`;
    try {
      writeUserSetting("integration-http-other", "integration.telegram.enabled", true);
      writeUserSetting("integration-http-other", "plexToken", "never-expose-this-token");
      const response = await fetch(base);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.doesNotMatch(text, /never-expose|plexToken|serverUrl|ratingKey/);
      ListIntegrationsResponse.parse(JSON.parse(text));
      const patch = (id: string, body: unknown) => fetch(`${base}/${id}/config`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal((await patch("telegram", { enabled: false, ownerId: "integration-http-other" })).status, 400);
      assert.equal((await patch("telegram", { enabled: "true" })).status, 400);
      assert.equal((await patch("telegram", {})).status, 400);
      assert.equal((await patch("telegram", { enabled: false, token: "secret" })).status, 400);
      assert.equal((await patch("missing", { enabled: true })).status, 404);
      const updated = await patch("telegram", { enabled: false });
      assert.equal(updated.status, 200);
      assert.equal((await updated.json()).enabled, false);
      assert.equal(integrations.describe(runtimeConfig.localOwnerId, "telegram").enabled, false);
      assert.equal(integrations.describe("integration-http-other", "telegram").enabled, true);
      assert.equal((await fetch(`${base}/telegram/test-connection`, { method: "POST" })).status, 200);
      assert.equal((await fetch(`${base}/telegram/inventory`)).status, 409);
      assert.equal((await fetch(`${base}/missing/inventory`)).status, 404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
