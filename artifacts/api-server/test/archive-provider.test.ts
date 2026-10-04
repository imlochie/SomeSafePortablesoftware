import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { archiveDb, writeUserSetting } from "../src/lib/archive-db";
import {
  availableArchiveProviders,
  invalidateArchiveInventoryCache,
  providerLabel,
  readArchiveInventory,
  readArchiveProviderSelection,
  resolveArchiveProvider,
  setArchiveProvider,
} from "../src/services/archive";

const owner = "archive-provider-owner";

function resetOwner(ownerId: string) {
  archiveDb.prepare("DELETE FROM file_record WHERE owner_id = ?").run(ownerId);
  archiveDb.prepare("DELETE FROM plex_item WHERE owner_id = ?").run(ownerId);
  archiveDb.prepare("DELETE FROM plex_library WHERE owner_id = ?").run(ownerId);
  archiveDb.prepare("DELETE FROM jellyfin_item WHERE owner_id = ?").run(ownerId);
  archiveDb.prepare("DELETE FROM jellyfin_library WHERE owner_id = ?").run(ownerId);
  archiveDb.prepare(
    "DELETE FROM user_setting WHERE owner_id = ? AND key = 'archiveProvider'",
  ).run(ownerId);
  invalidateArchiveInventoryCache(ownerId);
}

/** Insert a local archive file that should match the seeded server item. */
function seedLocalFile(ownerId: string, filename: string) {
  archiveDb.prepare(`
    INSERT INTO file_record
      (path, size_bytes, checksum, media_type, filename, relative_path, scan_status,
       extension, height, video_codec, audio_codec, container, owner_id)
    VALUES (?, ?, ?, 'matroska', ?, ?, 'active', 'mkv', 1080, 'h264', 'aac', 'matroska', ?)
  `).run(
    `/archive/${filename}`,
    1_000_000,
    `checksum-${filename}`,
    filename,
    filename,
    ownerId,
  );
}

function seedPlexItem(ownerId: string, title: string, year: number) {
  const library = archiveDb.prepare(`
    INSERT INTO plex_library (name, server_url, library_key, library_type, owner_id, sync_status)
    VALUES ('Movies', 'http://plex.test', 'p1', 'movie', ?, 'synced')
  `).run(ownerId);
  archiveDb.prepare(`
    INSERT INTO plex_item
      (library_id, rating_key, title, item_type, year, metadata_json, owner_id)
    VALUES (?, ?, ?, 'movie', ?, '{}', ?)
  `).run(Number(library.lastInsertRowid), `plex-${title}`, title, year, ownerId);
}

function seedJellyfinItem(ownerId: string, title: string, year: number) {
  const library = archiveDb.prepare(`
    INSERT INTO jellyfin_library
      (name, server_url, library_key, library_type, owner_id, sync_status)
    VALUES ('Movies', 'http://jellyfin.test', 'j1', 'movies', ?, 'synced')
  `).run(ownerId);
  archiveDb.prepare(`
    INSERT INTO jellyfin_item
      (library_id, item_key, title, item_type, year, metadata_json, owner_id)
    VALUES (?, ?, ?, 'movie', ?, '{}', ?)
  `).run(Number(library.lastInsertRowid), `jf-${title}`, title, year, ownerId);
}

describe("provider-aware archive comparison", { concurrency: false }, () => {
  test("provider labels stay operator-facing", () => {
    assert.equal(providerLabel("plex"), "Plex");
    assert.equal(providerLabel("jellyfin"), "Jellyfin");
  });

  test("plex remains the default provider when nothing is configured", () => {
    resetOwner(owner);
    assert.equal(resolveArchiveProvider(owner), "plex");
  });

  test("an owner with only Jellyfin inventory compares against Jellyfin automatically", () => {
    resetOwner(owner);
    seedJellyfinItem(owner, "Solo", 2024);
    assert.equal(
      resolveArchiveProvider(owner),
      "jellyfin",
      "a Jellyfin-only owner should not silently fall back to an empty Plex inventory",
    );
  });

  test("an explicit provider setting overrides inventory-based inference", () => {
    resetOwner(owner);
    seedJellyfinItem(owner, "Solo", 2024);
    writeUserSetting(owner, "archiveProvider", "plex");
    assert.equal(resolveArchiveProvider(owner), "plex");

    writeUserSetting(owner, "archiveProvider", "jellyfin");
    assert.equal(resolveArchiveProvider(owner), "jellyfin");

    // An unrecognized value must not disable comparison entirely.
    writeUserSetting(owner, "archiveProvider", "emby");
    assert.equal(resolveArchiveProvider(owner), "jellyfin");
  });

  test("a Jellyfin match is reported as a Jellyfin match, not a Plex one", () => {
    resetOwner(owner);
    seedLocalFile(owner, "Gamma.2024.mkv");
    seedJellyfinItem(owner, "Gamma", 2024);
    writeUserSetting(owner, "archiveProvider", "jellyfin");
    invalidateArchiveInventoryCache(owner);

    const inventory = readArchiveInventory(owner);
    assert.equal(inventory.provider, "jellyfin");
    assert.equal(inventory.providerLabel, "Jellyfin");

    const record = inventory.records.find((item) => item.filename === "Gamma.2024.mkv");
    assert.ok(record, "the seeded local file should appear in the inventory");
    assert.ok(record.plexMatch, "the Jellyfin item should match the local file");
    assert.equal(record.plexMatch.provider, "jellyfin");
    assert.equal(record.plexMatch.providerLabel, "Jellyfin");
    assert.equal(
      record.qualitySummary.includes("Plex"),
      false,
      `summary must not mention Plex for a Jellyfin match: ${record.qualitySummary}`,
    );
  });

  test("unmatched Jellyfin items are attributed to Jellyfin in the provider-only list", () => {
    resetOwner(owner);
    seedJellyfinItem(owner, "Orphan", 2020);
    writeUserSetting(owner, "archiveProvider", "jellyfin");
    invalidateArchiveInventoryCache(owner);

    const inventory = readArchiveInventory(owner);
    assert.equal(inventory.plexOnly.length, 1);
    const orphan = inventory.plexOnly[0];
    assert.ok(orphan);
    assert.equal(orphan.provider, "jellyfin");
    assert.equal(orphan.providerLabel, "Jellyfin");
    assert.match(orphan.qualitySummary, /^Jellyfin contains this item/);
  });

  test("switching providers re-attributes the same local file", () => {
    resetOwner(owner);
    seedLocalFile(owner, "Delta.2024.mkv");
    seedPlexItem(owner, "Delta", 2024);
    seedJellyfinItem(owner, "Delta", 2024);

    writeUserSetting(owner, "archiveProvider", "plex");
    invalidateArchiveInventoryCache(owner);
    const viaPlex = readArchiveInventory(owner);
    assert.equal(viaPlex.provider, "plex");
    const plexRecord = viaPlex.records.find((item) => item.filename === "Delta.2024.mkv");
    assert.equal(plexRecord?.plexMatch?.provider, "plex");
    assert.equal(plexRecord?.plexMatch?.providerLabel, "Plex");

    writeUserSetting(owner, "archiveProvider", "jellyfin");
    invalidateArchiveInventoryCache(owner);
    const viaJellyfin = readArchiveInventory(owner);
    assert.equal(viaJellyfin.provider, "jellyfin");
    const jellyfinRecord = viaJellyfin.records.find((item) => item.filename === "Delta.2024.mkv");
    assert.equal(jellyfinRecord?.plexMatch?.provider, "jellyfin");
    assert.equal(jellyfinRecord?.plexMatch?.providerLabel, "Jellyfin");

    resetOwner(owner);
  });

  test("the provider selection reports what is actually available", () => {
    resetOwner(owner);
    assert.deepEqual(readArchiveProviderSelection(owner), {
      provider: "plex",
      providerLabel: "Plex",
      available: [],
    });

    seedPlexItem(owner, "Available", 2024);
    seedJellyfinItem(owner, "Available", 2024);
    assert.deepEqual(availableArchiveProviders(owner), ["plex", "jellyfin"]);

    const selected = setArchiveProvider(owner, "jellyfin");
    assert.equal(selected.provider, "jellyfin");
    assert.equal(selected.providerLabel, "Jellyfin");
    assert.equal(resolveArchiveProvider(owner), "jellyfin");

    assert.throws(
      () => setArchiveProvider(owner, "emby" as never),
      /not supported/,
    );
    resetOwner(owner);
  });

  test("changing the provider invalidates the cached inventory", () => {
    resetOwner(owner);
    seedLocalFile(owner, "Cached.2024.mkv");
    seedPlexItem(owner, "Cached", 2024);
    seedJellyfinItem(owner, "Cached", 2024);

    setArchiveProvider(owner, "plex");
    assert.equal(
      readArchiveInventory(owner).records
        .find((item) => item.filename === "Cached.2024.mkv")?.plexMatch?.provider,
      "plex",
    );

    // Without cache invalidation this would still report the Plex match.
    setArchiveProvider(owner, "jellyfin");
    assert.equal(
      readArchiveInventory(owner).records
        .find((item) => item.filename === "Cached.2024.mkv")?.plexMatch?.provider,
      "jellyfin",
    );
    resetOwner(owner);
  });

  test("inventories stay owner-scoped across providers", () => {
    resetOwner(owner);
    resetOwner("archive-provider-other");
    seedJellyfinItem(owner, "Private", 2024);
    writeUserSetting(owner, "archiveProvider", "jellyfin");
    invalidateArchiveInventoryCache(owner);
    invalidateArchiveInventoryCache("archive-provider-other");

    assert.equal(readArchiveInventory(owner).plexOnly.length, 1);
    assert.equal(readArchiveInventory("archive-provider-other").plexOnly.length, 0);
    resetOwner(owner);
  });
});
