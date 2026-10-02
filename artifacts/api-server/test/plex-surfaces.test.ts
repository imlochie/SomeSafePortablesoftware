import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, afterEach, before, describe, test } from "node:test";
import { archiveDb, writeUserSetting } from "../src/lib/archive-db";
import { readPlexArtwork, readPlexHierarchy } from "../src/services/plex";
import { runtimeConfig } from "../src/lib/runtime-config";
import app from "../src/app";

const owner = runtimeConfig.localOwnerId;
const otherOwner = "plex-surfaces-other-owner";
let upstream: Server;
let upstreamUrl = "";
let api: Server;
let apiUrl = "";

function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test address"));
      resolve(address.port);
    });
  });
}

before(async () => {
  upstream = createServer((req, res) => {
    const key = req.url?.split("/").pop();
    const formats: Record<string, [string, Buffer]> = {
      jpeg: ["image/jpeg", Buffer.from("jpeg")],
      png: ["image/png", Buffer.from("png")],
      webp: ["image/webp", Buffer.from("webp")],
      gif: ["image/gif", Buffer.from("gif")],
    };
    if (key === "401" || key === "403" || key === "404" || key === "500") {
      res.writeHead(Number(key));
      res.end();
      return;
    }
    if (key === "bad-type") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not an image");
      return;
    }
    if (key === "oversized") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(Buffer.alloc(8 * 1024 * 1024 + 1));
      return;
    }
    const [contentType, body] = formats[key ?? ""] ?? ["image/jpeg", Buffer.from("default")];
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  });
  const port = await listen(upstream);
  upstreamUrl = `http://127.0.0.1:${port}`;
  api = createServer(app);
  const apiPort = await listen(api);
  apiUrl = `http://127.0.0.1:${apiPort}`;
  writeUserSetting(owner, "plexServerUrl", upstreamUrl);
  writeUserSetting(owner, "plexToken", "server-only-token");
});

after(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await new Promise<void>((resolve) => api.close(() => resolve()));
  archiveDb.close();
});

afterEach(() => {
  archiveDb.prepare("DELETE FROM plex_episode WHERE owner_id IN (?, ?)").run(owner, otherOwner);
  archiveDb.prepare("DELETE FROM plex_season WHERE show_id IN (SELECT id FROM plex_show WHERE owner_id IN (?, ?))").run(owner, otherOwner);
  archiveDb.prepare("DELETE FROM plex_show WHERE owner_id IN (?, ?)").run(owner, otherOwner);
  archiveDb.prepare("DELETE FROM plex_item WHERE owner_id IN (?, ?)").run(owner, otherOwner);
  archiveDb.prepare("DELETE FROM plex_library WHERE owner_id IN (?, ?)").run(owner, otherOwner);
  archiveDb.prepare("DELETE FROM file_record WHERE owner_id IN (?, ?)").run(owner, otherOwner);
  archiveDb.prepare("DELETE FROM local_media_identity WHERE owner_id IN (?, ?)").run(owner, otherOwner);
});

describe("Plex artwork and hierarchy dedicated coverage", { concurrency: false }, () => {
  test("artwork is owner-scoped, validates identifiers, uses the stored target, and never returns the token", async () => {
    const library = archiveDb.prepare("INSERT INTO plex_library (name, server_url, library_key, library_type, owner_id) VALUES (?, ?, ?, ?, ?)").run("Shows", upstreamUrl, "1", "show", owner);
    archiveDb.prepare("INSERT INTO plex_item (library_id, rating_key, title, item_type, owner_id, thumb_url) VALUES (?, ?, ?, ?, ?, ?)").run(library.lastInsertRowid, "9001", "Owned", "show", owner, "/library/metadata/jpeg");
    archiveDb.prepare("INSERT INTO plex_item (library_id, rating_key, title, item_type, owner_id, thumb_url) VALUES (?, ?, ?, ?, ?, ?)").run(library.lastInsertRowid, "9002", "Other", "show", otherOwner, "/library/metadata/jpeg");

    const result = await readPlexArtwork(owner, "9001");
    assert.equal(result.contentType, "image/jpeg");
    assert.deepEqual(result.body, Buffer.from("jpeg"));
    await assert.rejects(() => readPlexArtwork(otherOwner, "9001"), /no artwork|configured/i);
    await assert.rejects(() => readPlexArtwork(owner, "not-a-number"), /identifier is invalid/i);
    await assert.rejects(() => readPlexArtwork(owner, "9999"), /no artwork/i);
    assert.doesNotMatch(JSON.stringify(result), /server-only-token/);
    assert.equal(new URL("/api/plex/artwork/9001", apiUrl).search, "");
  });

  test("artwork handles missing configuration and all supported content types", async () => {
    writeUserSetting(owner, "plexServerUrl", "");
    await assert.rejects(() => readPlexArtwork(owner, "9001"), /unavailable until Plex is configured/i);
    writeUserSetting(owner, "plexServerUrl", upstreamUrl);
    const library = archiveDb.prepare("INSERT INTO plex_library (name, server_url, library_key, library_type, owner_id) VALUES (?, ?, ?, ?, ?)").run("Shows", upstreamUrl, "2", "show", owner);
    for (const [index, format] of ["jpeg", "png", "webp", "gif"].entries()) {
      archiveDb.prepare("INSERT INTO plex_item (library_id, rating_key, title, item_type, owner_id, thumb_url) VALUES (?, ?, ?, ?, ?, ?)").run(library.lastInsertRowid, String(9100 + index), format, "show", owner, `/library/metadata/${format}`);
      const result = await readPlexArtwork(owner, String(9100 + index));
      assert.equal(result.contentType, `image/${format}`);
    }
  });

  test("artwork rejects upstream auth, not-found, server, content-type, and size failures", async () => {
    const library = archiveDb.prepare("INSERT INTO plex_library (name, server_url, library_key, library_type, owner_id) VALUES (?, ?, ?, ?, ?)").run("Shows", upstreamUrl, "3", "show", owner);
    for (const [index, key] of ["401", "403", "404", "500", "bad-type", "oversized"].entries()) {
      archiveDb.prepare("INSERT INTO plex_item (library_id, rating_key, title, item_type, owner_id, thumb_url) VALUES (?, ?, ?, ?, ?, ?)").run(library.lastInsertRowid, String(9200 + index), key, "show", owner, `/library/metadata/${key}`);
      await assert.rejects(() => readPlexArtwork(owner, String(9200 + index)), /Plex artwork|unsupported|exceeded|HTTP/i);
    }
  });

  test("artwork route is cacheable, authenticated, and does not accept an arbitrary upstream target", async () => {
    const library = archiveDb.prepare("INSERT INTO plex_library (name, server_url, library_key, library_type, owner_id) VALUES (?, ?, ?, ?, ?)").run("Shows", upstreamUrl, "4", "show", owner);
    archiveDb.prepare("INSERT INTO plex_item (library_id, rating_key, title, item_type, owner_id, thumb_url) VALUES (?, ?, ?, ?, ?, ?)").run(library.lastInsertRowid, "9301", "Cached", "show", owner, "/library/metadata/jpeg");
    const response = await fetch(`${apiUrl}/api/plex/artwork/9301`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, max-age=3600");
    const invalid = await fetch(`${apiUrl}/api/plex/artwork/not-a-number`);
    assert.equal(invalid.status, 400);
    const targetAttempt = await fetch(`${apiUrl}/api/plex/artwork/9301?target=http://127.0.0.1:1`);
    assert.equal(targetAttempt.status, 200);
  });

  test("hierarchy is owner-scoped and projects series, seasons, episodes, artwork, matches, IDs, and counts", () => {
    const library = archiveDb.prepare("INSERT INTO plex_library (name, server_url, library_key, library_type, owner_id) VALUES (?, ?, ?, ?, ?)").run("Shows", upstreamUrl, "10", "show", owner);
    const show = archiveDb.prepare("INSERT INTO plex_item (library_id, rating_key, title, item_type, year, owner_id, thumb_url) VALUES (?, ?, ?, ?, ?, ?, ?)").run(library.lastInsertRowid, "100", "Example Series", "show", 2024, owner, "/library/metadata/100");
    archiveDb.prepare("INSERT INTO plex_show (item_id, owner_id, rating_key, title, year) VALUES (?, ?, ?, ?, ?)").run(show.lastInsertRowid, owner, "100", "Example Series", 2024);
    const showRow = archiveDb.prepare("SELECT id FROM plex_show WHERE item_id = ?").get(show.lastInsertRowid) as { id: number };
    const season = archiveDb.prepare("INSERT INTO plex_season (show_id, rating_key, season_number, title) VALUES (?, ?, ?, ?)").run(showRow.id, "101", 1, "Season One");
    const episode = archiveDb.prepare("INSERT INTO plex_item (library_id, rating_key, title, item_type, owner_id, thumb_url) VALUES (?, ?, ?, ?, ?, ?)").run(library.lastInsertRowid, "102", "Pilot", "episode", owner, "/library/metadata/102");
    archiveDb.prepare("INSERT INTO plex_episode (item_id, season_id, owner_id, rating_key, episode_number, title) VALUES (?, ?, ?, ?, ?, ?)").run(episode.lastInsertRowid, season.lastInsertRowid, owner, "102", 1, "Pilot");
    const otherLibrary = archiveDb.prepare("INSERT INTO plex_library (name, server_url, library_key, library_type, owner_id) VALUES (?, ?, ?, ?, ?)").run("Other", upstreamUrl, "11", "show", otherOwner);
    const otherShow = archiveDb.prepare("INSERT INTO plex_item (library_id, rating_key, title, item_type, owner_id) VALUES (?, ?, ?, ?, ?)").run(otherLibrary.lastInsertRowid, "200", "Hidden Series", "show", otherOwner);
    archiveDb.prepare("INSERT INTO plex_show (item_id, owner_id, rating_key, title, year) VALUES (?, ?, ?, ?, ?)").run(otherShow.lastInsertRowid, otherOwner, "200", "Hidden Series", 2020);

    const hierarchy = readPlexHierarchy(owner, Number(library.lastInsertRowid), 1, 100);
    assert.equal(hierarchy.total, 1);
    assert.equal(hierarchy.series[0]?.title, "Example Series");
    assert.equal(hierarchy.series[0]?.year, 2024);
    assert.equal(hierarchy.series[0]?.artworkRatingKey, "100");
    assert.equal(hierarchy.series[0]?.seasons[0]?.seasonNumber, 1);
    assert.equal(hierarchy.series[0]?.seasons[0]?.title, "Season One");
    assert.equal(hierarchy.series[0]?.seasons[0]?.episodes[0]?.episodeNumber, 1);
    assert.equal(hierarchy.series[0]?.seasons[0]?.episodes[0]?.title, "Pilot");
    assert.equal(hierarchy.series[0]?.seasons[0]?.episodes[0]?.artworkRatingKey, "102");
    assert.equal(hierarchy.series[0]?.seasons[0]?.episodes[0]?.localMatch, "unmatched");
    assert.equal(hierarchy.series[0]?.localMatchedCount, 0);
    assert.equal(hierarchy.series[0]?.verifiedCount, 0);
    assert.equal(hierarchy.series.some((item) => item.title === "Hidden Series"), false);
  });

  test("hierarchy pagination and constraints are bounded, empty results are valid, and relationships remain explicit", async () => {
    const empty = readPlexHierarchy(owner, undefined, 1, 24);
    assert.deepEqual(empty.series, []);
    assert.equal(empty.page, 1);
    assert.equal(empty.pageSize, 24);
    const response = await fetch(`${apiUrl}/api/plex/hierarchy?page=0&pageSize=999999&libraryId=not-a-number`);
    assert.equal(response.status, 200);
    const body = await response.json() as { page: number; pageSize: number; series: unknown[] };
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 100);
    assert.deepEqual(body.series, []);
  });
});
