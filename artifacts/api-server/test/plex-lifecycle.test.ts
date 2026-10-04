import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { getPlexConfig, savePlexConfig, startPlexSync } from "../src/services/plex";

test("Plex refresh failure releases the guard and supports explicit retry", async () => {
  let failIdentity = true;
  let delayIdentityMs = 0;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers["x-plex-token"] !== "valid-token") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/identity" && failIdentity) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: "deterministic Plex failure" }));
    }
    if (url.pathname === "/identity") {
      const response = () => res.end(JSON.stringify({ MediaContainer: { friendlyName: "Test Plex" } }));
      if (delayIdentityMs < 0) return;
      if (delayIdentityMs > 0) return void setTimeout(response, delayIdentityMs);
      return response();
    }
    if (url.pathname === "/library/sections") return res.end(JSON.stringify({ MediaContainer: { Directory: [] } }));
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const owner = `plex-failure-owner-${Date.now()}`;
  try {
    savePlexConfig(owner, { serverUrl: `http://127.0.0.1:${address.port}`, token: "valid-token" });
    startPlexSync(owner);
    assert.throws(() => startPlexSync(owner), /already running/i);
    for (let attempt = 0; attempt < 20 && !["sync_error", "synced"].includes(getPlexConfig(owner).syncStatus); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const failed = getPlexConfig(owner);
    assert.equal(failed.syncStatus, "sync_error");
    assert.ok(failed.lastError);
    assert.equal(failed.lastSuccessfulSyncAt, null);
    failIdentity = false;
    startPlexSync(owner);
    for (let attempt = 0; attempt < 20 && !["sync_error", "synced"].includes(getPlexConfig(owner).syncStatus); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(getPlexConfig(owner).syncStatus, "synced");
    assert.ok(getPlexConfig(owner).lastSuccessfulSyncAt);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Plex request timeout releases the guard and permits retry", async () => {
  let delayIdentityMs = -1;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers["x-plex-token"] !== "valid-token") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/identity") {
      const response = () => res.end(JSON.stringify({ MediaContainer: { friendlyName: "Timeout Plex" } }));
      if (delayIdentityMs < 0) return;
      return delayIdentityMs > 0 ? void setTimeout(response, delayIdentityMs) : response();
    }
    if (url.pathname === "/library/sections") return res.end(JSON.stringify({ MediaContainer: { Directory: [] } }));
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const owner = `plex-timeout-owner-${Date.now()}`;
  try {
    savePlexConfig(owner, { serverUrl: `http://127.0.0.1:${address.port}`, token: "valid-token" });
    startPlexSync(owner);
    for (let attempt = 0; attempt < 700 && !["sync_error", "synced"].includes(getPlexConfig(owner).syncStatus); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const timedOut = getPlexConfig(owner);
    assert.equal(timedOut.syncStatus, "sync_error");
    assert.match(timedOut.lastError ?? "", /timed out/i);
    assert.equal(timedOut.lastSuccessfulSyncAt, null);
    delayIdentityMs = 0;
    startPlexSync(owner);
    for (let attempt = 0; attempt < 700 && !["sync_error", "synced"].includes(getPlexConfig(owner).syncStatus); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(getPlexConfig(owner).syncStatus, "synced");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
