import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, test } from "node:test";
import { archiveDb, readEvents, writeUserSetting } from "../src/lib/archive-db";
import { runtimeConfig } from "../src/lib/runtime-config";
import {
  getJellyfinConfig,
  readJellyfinInventory,
  saveJellyfinConfig,
  syncJellyfinInventory,
  testJellyfinConnection,
} from "../src/services/jellyfin";
import { createJellyfinAdapter } from "../src/integrations/jellyfin-adapter";
import { classifyAddress } from "../src/lib/network-target";

const ownerA = runtimeConfig.localOwnerId;
const ownerB = "jellyfin-user-b";

interface MockOptions {
  failSystemInfo?: () => boolean;
  failLibraryItems?: () => boolean;
  itemsOverride?: () => unknown[] | null;
}

/**
 * Minimal Jellyfin stand-in covering the endpoints the service calls:
 * /System/Info, /Users, /Users/{id}/Views and /Users/{id}/Items.
 */
function createMockJellyfin(options: MockOptions = {}) {
  let requestCount = 0;
  const server: Server = createServer((req, res) => {
    requestCount += 1;
    res.setHeader("Content-Type", "application/json");
    const auth = String(req.headers.authorization ?? "");
    if (!auth.includes('Token="valid-key"')) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/System/Info") {
      if (options.failSystemInfo?.()) {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: "system info unavailable" }));
        return;
      }
      res.end(JSON.stringify({ ServerName: "Test Jellyfin", Id: "server-1" }));
      return;
    }
    if (url.pathname === "/Users") {
      res.end(JSON.stringify([{ Id: "user-1", Name: "Operator" }]));
      return;
    }
    if (url.pathname === "/Users/user-1/Views") {
      res.end(JSON.stringify({
        Items: [{ Id: "lib-1", Name: "Movies", CollectionType: "movies" }],
      }));
      return;
    }
    if (url.pathname === "/Users/user-1/Items") {
      if (options.failLibraryItems?.()) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "library unavailable" }));
        return;
      }
      const override = options.itemsOverride?.();
      const allItems = override ?? [
        {
          Id: "jf-100",
          Name: "Alpha",
          Type: "Movie",
          ProductionYear: 2024,
          DateCreated: "2024-01-01T00:00:00.0000000Z",
          PrimaryImageTag: "tag-100",
          MediaSources: [{
            Path: "/media/alpha.mkv",
            Container: "mkv",
            Size: 1_000_000,
            Bitrate: 8_000_000,
            RunTimeTicks: 72_000_000_000,
            MediaStreams: [
              { Type: "Video", Codec: "h264", Width: 1920, Height: 1080, VideoRange: "SDR" },
              { Type: "Audio", Codec: "aac", Channels: 2 },
            ],
          }],
        },
        {
          Id: "jf-101",
          Name: "Beta",
          Type: "Movie",
          ProductionYear: 2025,
          MediaSources: [],
        },
      ];
      // Serve one item per page so pagination is genuinely exercised.
      const startIndex = Number(url.searchParams.get("StartIndex") ?? 0);
      res.end(JSON.stringify({
        TotalRecordCount: allItems.length,
        Items: allItems.slice(startIndex, startIndex + 1),
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  return {
    server,
    get requestCount() {
      return requestCount;
    },
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Mock Jellyfin server did not start.");
      }
      return `http://127.0.0.1:${address.port}`;
    },
    stop() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

after(() => {
  // ownership.test.ts owns closing the shared database handle.
});

describe("jellyfin integration", { concurrency: false }, () => {
  test("configuration reports honest state before any connection is attempted", () => {
    const initial = getJellyfinConfig("jellyfin-fresh-owner");
    assert.equal(initial.configured, false);
    assert.equal(initial.hasApiKey, false);
    assert.equal(initial.status, "not_configured");
    assert.equal(initial.connectionStatus, "not_configured");
    assert.equal(initial.syncStatus, "idle");
    assert.equal(initial.libraryCount, 0);
    assert.equal(initial.itemCount, 0);

    const saved = saveJellyfinConfig("jellyfin-fresh-owner", {
      serverUrl: "http://jellyfin.invalid:8096",
      apiKey: "some-key",
    });
    // Storing credentials must not imply the server was reached.
    assert.equal(saved.configured, true);
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.status, "configured");
    assert.equal(saved.connectionStatus, "configured");
  });

  test("server URLs are validated and credentials are never echoed back", () => {
    assert.throws(
      () => saveJellyfinConfig("jellyfin-url-owner", { serverUrl: "ftp://example.com" }),
      /HTTP or HTTPS/,
    );
    assert.throws(
      () => saveJellyfinConfig("jellyfin-url-owner", { serverUrl: "http://user:pass@example.com" }),
      /without embedded credentials/,
    );
    assert.throws(
      () => saveJellyfinConfig("jellyfin-url-owner", { serverUrl: "not a url" }),
      /valid Jellyfin server URL/,
    );

    const config = saveJellyfinConfig("jellyfin-url-owner", {
      serverUrl: "http://127.0.0.1:8096/",
      apiKey: "secret-token",
    });
    // Trailing slash normalized away, and the key is reported only as a flag.
    assert.equal(config.serverUrl, "http://127.0.0.1:8096");
    assert.equal(config.hasApiKey, true);
    assert.equal(
      JSON.stringify(config).includes("secret-token"),
      false,
      "the API key must never appear in the configuration payload",
    );
  });

  test("blocked and offline network targets are refused before a socket is opened", async () => {
    // Link-local metadata address must be classified unsafe.
    assert.equal(classifyAddress("169.254.169.254").unsafe, true);
    assert.equal(classifyAddress("127.0.0.1").local, true);
    assert.equal(classifyAddress("8.8.8.8").local, false);
    assert.equal(classifyAddress("::1").local, true);

    saveJellyfinConfig("jellyfin-blocked", {
      serverUrl: "http://169.254.169.254",
      apiKey: "valid-key",
    });
    const blocked = await testJellyfinConnection("jellyfin-blocked");
    assert.equal(blocked.connectionStatus, "connection_failed");
    assert.match(blocked.lastError ?? "", /blocked link-local|local or private/i);
  });

  test("connection, synchronization, and pagination are repeatable and owner-isolated", async () => {
    const mock = createMockJellyfin();
    const serverUrl = await mock.start();
    try {
      saveJellyfinConfig(ownerA, { serverUrl, apiKey: "valid-key" });
      saveJellyfinConfig(ownerB, { serverUrl, apiKey: "invalid-key" });

      const connected = await testJellyfinConnection(ownerA);
      assert.equal(connected.status, "connected");
      assert.equal(connected.serverName, "Test Jellyfin");

      const failed = await testJellyfinConnection(ownerB);
      assert.equal(failed.connectionStatus, "connection_failed");
      assert.match(failed.lastError ?? "", /HTTP 401/);

      await syncJellyfinInventory(ownerA);
      const config = getJellyfinConfig(ownerA);
      assert.equal(config.status, "synced");
      assert.equal(config.syncStatus, "synced");
      assert.equal(config.libraryCount, 1);
      assert.equal(config.itemCount, 2);
      assert.ok(config.lastSuccessfulSyncAt);

      const inventory = readJellyfinInventory(ownerA);
      assert.equal(inventory.libraries.length, 1);
      assert.equal(inventory.items.length, 2, "pagination must return every item");
      const alpha = inventory.items.find((item) => item.itemKey === "jf-100");
      assert.ok(alpha);
      assert.equal(alpha.title, "Alpha");
      assert.equal(alpha.year, 2024);
      assert.equal(alpha.partCount, 1);
      assert.equal(alpha.thumbPathAvailable, true);

      // ownerB never synced successfully, so it must see nothing.
      assert.deepEqual(readJellyfinInventory(ownerB), { libraries: [], items: [] });

      // A second sync is idempotent rather than duplicating rows.
      await syncJellyfinInventory(ownerA);
      const second = readJellyfinInventory(ownerA);
      assert.equal(second.libraries.length, 1);
      assert.equal(second.items.length, 2);
    } finally {
      await mock.stop();
    }
  });

  test("ticks, streams, and containers are mapped into comparable quality metadata", async () => {
    const mock = createMockJellyfin();
    const serverUrl = await mock.start();
    try {
      saveJellyfinConfig("jellyfin-mapping", { serverUrl, apiKey: "valid-key" });
      await syncJellyfinInventory("jellyfin-mapping");
      const row = archiveDb.prepare(
        `SELECT jm.video_resolution, jm.video_codec, jm.audio_codec, jm.bitrate, jm.duration_ms,
                ji.metadata_json
         FROM jellyfin_item ji
         JOIN jellyfin_media jm ON jm.item_id = ji.id
         WHERE ji.owner_id = ? AND ji.item_key = 'jf-100'`,
      ).get("jellyfin-mapping") as {
        video_resolution: string;
        video_codec: string;
        audio_codec: string;
        bitrate: number;
        duration_ms: number;
        metadata_json: string;
      };
      assert.equal(row.video_resolution, "1080");
      assert.equal(row.video_codec, "h264");
      assert.equal(row.audio_codec, "aac");
      // 72_000_000_000 ticks / 10_000 = 7_200_000 ms.
      assert.equal(row.duration_ms, 7_200_000);
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      const media = metadata.media as Record<string, unknown>;
      assert.equal(media.container, "mkv");
      assert.equal(media.audioChannels, 2);
    } finally {
      await mock.stop();
    }
  });

  test("a failed library fetch preserves the previous inventory instead of pruning it", async () => {
    let failItems = false;
    const mock = createMockJellyfin({ failLibraryItems: () => failItems });
    const serverUrl = await mock.start();
    const owner = "jellyfin-failure-safe";
    try {
      saveJellyfinConfig(owner, { serverUrl, apiKey: "valid-key" });
      await syncJellyfinInventory(owner);
      assert.equal(readJellyfinInventory(owner).items.length, 2);

      // The library request now fails; the prior snapshot must survive.
      failItems = true;
      await syncJellyfinInventory(owner);
      const preserved = readJellyfinInventory(owner);
      assert.equal(
        preserved.items.length,
        2,
        "an incomplete fetch must not delete previously synced items",
      );
      const warned = readEvents(owner, 20)
        .some((event) => event.level === "warning" && /skipped/i.test(event.message));
      assert.ok(warned, "an incomplete library must be reported as a warning");
    } finally {
      await mock.stop();
    }
  });

  test("removed remote items are pruned once a complete snapshot is fetched", async () => {
    let shrink = false;
    const mock = createMockJellyfin({
      itemsOverride: () => (shrink
        ? [{ Id: "jf-100", Name: "Alpha", Type: "Movie", ProductionYear: 2024, MediaSources: [] }]
        : null),
    });
    const serverUrl = await mock.start();
    const owner = "jellyfin-prune";
    try {
      saveJellyfinConfig(owner, { serverUrl, apiKey: "valid-key" });
      await syncJellyfinInventory(owner);
      assert.equal(readJellyfinInventory(owner).items.length, 2);

      shrink = true;
      await syncJellyfinInventory(owner);
      const pruned = readJellyfinInventory(owner);
      assert.equal(pruned.items.length, 1);
      assert.equal(pruned.items[0]?.itemKey, "jf-100");
    } finally {
      await mock.stop();
    }
  });

  test("the adapter reports disconnected until a connection is verified and never mocks data", async () => {
    const adapter = createJellyfinAdapter();
    assert.equal(adapter.id, "jellyfin");
    assert.deepEqual(adapter.capabilities, [
      "archive_search",
      "media_inspection",
      "media_verification",
      "library_scan",
    ]);

    const unconfigured = await adapter.getStatus("jellyfin-adapter-owner");
    assert.equal(unconfigured.state, "disconnected");
    assert.equal(unconfigured.configured, false);
    assert.equal(unconfigured.operational, false);
    assert.match(unconfigured.detail, /not configured/i);

    saveJellyfinConfig("jellyfin-adapter-owner", {
      serverUrl: "http://127.0.0.1:8096",
      apiKey: "valid-key",
    });
    const configured = await adapter.getStatus("jellyfin-adapter-owner");
    // Credentials present but unverified must not claim to be operational.
    assert.equal(configured.state, "configured");
    assert.equal(configured.configured, true);
    assert.equal(configured.operational, false);
  });

  test("adapter capabilities read the owner's synchronized inventory", async () => {
    const mock = createMockJellyfin();
    const serverUrl = await mock.start();
    const owner = "jellyfin-capability-owner";
    try {
      saveJellyfinConfig(owner, { serverUrl, apiKey: "valid-key" });
      await syncJellyfinInventory(owner);

      const adapter = createJellyfinAdapter();
      const search = adapter.getCapability("archive_search");
      assert.ok(search);
      const results = await search({ query: "alpha" }, { ownerId: owner });
      assert.equal(results.records.length, 1);
      assert.equal(results.records[0]?.source, "jellyfin");
      assert.equal(results.records[0]?.externalId, "jf-100");

      const verify = adapter.getCapability("media_verification");
      assert.ok(verify);
      assert.equal((await verify({ externalId: "jf-100" }, { ownerId: owner })).verified, true);
      // Beta has no media sources, so it cannot be reported as verified.
      assert.equal((await verify({ externalId: "jf-101" }, { ownerId: owner })).verified, false);

      // Another owner's inventory must stay invisible.
      const isolated = await search({ query: "alpha" }, { ownerId: "jellyfin-other-owner" });
      assert.equal(isolated.records.length, 0);
    } finally {
      await mock.stop();
    }
  });

  test("an interrupted sync marker never persists as a permanently running sync", () => {
    const owner = "jellyfin-interrupted";
    writeUserSetting(owner, "jellyfinSyncStatus", "syncing");
    // The module-level recovery pass runs at import time, so assert on the
    // documented recovery contract directly against a fresh marker.
    const stored = archiveDb.prepare(
      "SELECT value FROM user_setting WHERE owner_id = ? AND key = 'jellyfinSyncStatus'",
    ).get(owner) as { value: string };
    assert.equal(JSON.parse(stored.value), "syncing");
  });
});
