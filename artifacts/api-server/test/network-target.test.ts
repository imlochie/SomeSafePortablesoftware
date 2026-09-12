/**
 * The shared network-target helpers.
 *
 * Plex and Jellyfin both reach outward through lib/network-target.ts. These
 * are the SSRF and egress rules for the whole application, so they are tested
 * directly rather than only through a provider: a hole here is a hole in every
 * provider at once.
 *
 * The final suite also pins the property that motivated the deduplication --
 * that both providers enforce identical rules -- so the two implementations
 * cannot silently drift apart again.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  classifyAddress,
  normalizeServerUrl,
  requestJson,
  validateServerTarget,
} from "../src/lib/network-target";
import { archiveDb } from "../src/lib/archive-db";

after(() => archiveDb.close());

class ConfigError extends Error {}
class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRequestError";
  }
}
const configurationError = (message: string) => new ConfigError(message);
const requestError = (message: string) => new RequestError(message);

const targetOptions = (networkMode: string) => ({
  label: "Plex",
  networkMode,
  configurationError,
  requestError,
});

describe("classifyAddress", () => {
  test("refuses addresses that must never be dialed", () => {
    // Cloud instance metadata: the classic SSRF target.
    assert.equal(classifyAddress("169.254.169.254").unsafe, true);
    assert.equal(classifyAddress("0.0.0.0").unsafe, true);
    assert.equal(classifyAddress("224.0.0.1").unsafe, true, "multicast");
    assert.equal(classifyAddress("255.255.255.255").unsafe, true, "broadcast");
    assert.equal(classifyAddress("::").unsafe, true);
    assert.equal(classifyAddress("fe80::1").unsafe, true, "IPv6 link-local");
    assert.equal(classifyAddress("ff02::1").unsafe, true, "IPv6 multicast");
  });

  test("recognizes private and loopback space as local", () => {
    for (const address of [
      "10.0.0.5",
      "127.0.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.10",
      "100.64.0.1", // CGNAT
    ]) {
      assert.equal(classifyAddress(address).local, true, `${address} is local`);
      assert.equal(classifyAddress(address).unsafe, false, `${address} is dialable`);
    }
    assert.equal(classifyAddress("::1").local, true);
    assert.equal(classifyAddress("fd00::1").local, true, "IPv6 unique local");
  });

  test("treats routable public addresses as neither unsafe nor local", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) {
      assert.equal(classifyAddress(address).local, false, `${address} is not local`);
      assert.equal(classifyAddress(address).unsafe, false, `${address} is dialable`);
    }
  });

  test("unwraps IPv4-mapped IPv6 so a mapped address cannot smuggle past the filter", () => {
    assert.deepEqual(classifyAddress("::ffff:169.254.169.254"), { unsafe: true, local: false });
    assert.deepEqual(classifyAddress("::FFFF:127.0.0.1"), { unsafe: false, local: true });
  });
});

describe("normalizeServerUrl", () => {
  test("keeps an empty setting empty rather than inventing a URL", () => {
    assert.equal(normalizeServerUrl("", "Plex", configurationError), "");
    assert.equal(normalizeServerUrl("   ", "Plex", configurationError), "");
    assert.equal(normalizeServerUrl(undefined, "Plex", configurationError), "");
    assert.equal(normalizeServerUrl(null, "Plex", configurationError), "");
  });

  test("trims whitespace and trailing slashes", () => {
    assert.equal(
      normalizeServerUrl("  http://127.0.0.1:32400///  ", "Plex", configurationError),
      "http://127.0.0.1:32400",
    );
    assert.equal(
      normalizeServerUrl("https://media.example/plex/", "Plex", configurationError),
      "https://media.example/plex",
    );
  });

  test("rejects non-HTTP schemes and embedded credentials, naming the provider", () => {
    for (const value of ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)"]) {
      assert.throws(
        () => normalizeServerUrl(value, "Plex", configurationError),
        /Plex server URL must use HTTP or HTTPS without embedded credentials\.|Enter a valid Plex server URL\./,
        value,
      );
    }
    // Credentials in the URL would otherwise be written to the settings row.
    assert.throws(
      () => normalizeServerUrl("http://user:password@example.com", "Plex", configurationError),
      /without embedded credentials/,
    );
    assert.throws(
      () => normalizeServerUrl("not a url", "Plex", configurationError),
      /Enter a valid Plex server URL\./,
    );
  });

  test("carries the caller's label into every message", () => {
    assert.throws(
      () => normalizeServerUrl("ftp://example.com", "Jellyfin", configurationError),
      /Jellyfin server URL must use HTTP or HTTPS/,
    );
  });
});

describe("validateServerTarget", () => {
  test("refuses every request while the network mode is offline", async () => {
    await assert.rejects(
      () => validateServerTarget("http://127.0.0.1:32400", targetOptions("offline")),
      /Network mode is offline\. Enable local network access before contacting Plex\./,
    );
  });

  test("refuses blocked addresses regardless of network mode", async () => {
    await assert.rejects(
      () => validateServerTarget("http://169.254.169.254", targetOptions("unrestricted")),
      /blocked link-local, multicast, or unspecified address/,
    );
  });

  test("local_only permits private targets and refuses public ones", async () => {
    const target = await validateServerTarget("http://127.0.0.1:32400", targetOptions("local_only"));
    assert.equal(target.address, "127.0.0.1");
    assert.equal(target.family, 4);
    assert.equal(target.url.port, "32400");

    await assert.rejects(
      () => validateServerTarget("http://8.8.8.8", targetOptions("local_only")),
      /Network mode only permits Plex servers on local or private addresses\./,
    );
  });

  test("reports an unresolvable hostname as a request failure", async () => {
    await assert.rejects(
      () => validateServerTarget("http://nonexistent.invalid", targetOptions("local_only")),
      /The Plex server hostname could not be resolved\./,
    );
  });

  test("accepts a bracketed IPv6 literal", async () => {
    const target = await validateServerTarget("http://[::1]:8096", targetOptions("local_only"));
    assert.equal(target.address, "::1");
    assert.equal(target.family, 6);
  });
});

describe("requestJson", () => {
  const servers: Server[] = [];
  const sockets = new Set<import("node:net").Socket>();
  after(() => {
    // Destroy live sockets before closing: the timeout and byte-cap cases
    // deliberately leave a connection open, and server.close() alone waits
    // for them, which would hang the run instead of ending it.
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
  });

  async function startServer(handler: Parameters<typeof createServer>[1]) {
    const server = createServer(handler);
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    // Never let a test server keep the process alive on its own.
    server.unref();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const target = await validateServerTarget(`http://127.0.0.1:${port}`, targetOptions("local_only"));
    return { target, port };
  }

  test("sends caller headers and parses a JSON body", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    let seenPath = "";
    const { target } = await startServer((req, res) => {
      seen = req.headers;
      seenPath = req.url ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ MediaContainer: { size: 2 } }));
    });

    const payload = await requestJson({
      target,
      path: "/library/sections?x=1",
      label: "Plex",
      requestError,
      headers: { "X-Plex-Token": "secret-token" },
    }) as { MediaContainer: { size: number } };

    assert.equal(payload.MediaContainer.size, 2);
    assert.equal(seenPath, "/library/sections?x=1", "the query string survives");
    assert.equal(seen["x-plex-token"], "secret-token");
    assert.equal(seen.accept, "application/json");
  });

  test("preserves the original Host header while dialing the resolved address", async () => {
    // Validation resolves a hostname, then the request dials the resolved
    // literal so the address cannot change between check and connection. The
    // Host header must still name the *configured* host, or a name-based
    // virtual host serves the wrong site.
    //
    // "localhost" is used deliberately: it resolves to 127.0.0.1, so the
    // configured host and the dialed address differ. With an IP literal they
    // are identical and Node's default Host header would mask a regression.
    let host = "";
    const server = createServer((req, res) => {
      host = req.headers.host ?? "";
      res.end("{}");
    });
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.unref();
    // Listen on every loopback interface: "localhost" may resolve to ::1 or
    // 127.0.0.1 depending on the host's resolver order.
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    const target = await validateServerTarget(`http://localhost:${port}`, targetOptions("local_only"));
    assert.ok(
      ["127.0.0.1", "::1"].includes(target.address),
      `the hostname resolved to a loopback literal (got ${target.address})`,
    );
    assert.notEqual(target.address, "localhost", "validation resolved the name to an address");
    await requestJson({ target, path: "/identity", label: "Plex", requestError, headers: {} });
    assert.equal(host, `localhost:${port}`, "the configured hostname is sent, not the dialed IP");
  });

  test("rejects a non-2xx status with the provider's label", async () => {
    const { target } = await startServer((_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    await assert.rejects(
      () => requestJson({ target, path: "/identity", label: "Plex", requestError, headers: {} }),
      /Plex request failed with HTTP 401\./,
    );
  });

  test("rejects an unreadable body rather than returning a partial object", async () => {
    const { target } = await startServer((_req, res) => res.end("<html>not json</html>"));
    await assert.rejects(
      () => requestJson({ target, path: "/identity", label: "Plex", requestError, headers: {} }),
      /Plex returned an unreadable response\./,
    );
  });

  test("treats an empty body as an empty object", async () => {
    // A 204 or deliberately empty response is a valid "nothing here" answer.
    const { target } = await startServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    assert.deepEqual(
      await requestJson({ target, path: "/identity", label: "Plex", requestError, headers: {} }),
      {},
    );
  });

  test("abandons a response that exceeds the byte cap", async () => {
    const { target } = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      // Stream well past the cap without ever completing the payload.
      const chunk = "x".repeat(64 * 1024);
      let stopped = false;
      const stop = () => { stopped = true; };
      res.on("close", stop);
      res.on("error", stop);
      const pump = () => {
        if (stopped || res.writableEnded || res.destroyed) return;
        res.write(chunk);
        setImmediate(pump);
      };
      pump();
    });
    await assert.rejects(
      () => requestJson({
        target,
        path: "/library/sections",
        label: "Plex",
        requestError,
        headers: {},
        maxResponseBytes: 256 * 1024,
      }),
      /Plex returned a response larger than/,
    );
  });

  test("gives up on a server that never answers", async () => {
    const { target } = await startServer(() => {
      // Accept the socket and stall forever.
    });
    // Raced against a watchdog: if the request timeout ever stops firing, this
    // fails in seconds instead of hanging the whole suite. A stalled provider
    // must never be able to wedge a scan, and a broken timeout must never be
    // able to wedge CI.
    const watchdog = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("requestJson never gave up; the request timeout did not fire.")),
        5_000,
      );
      timer.unref?.();
    });
    const attempt = requestJson({
      target,
      path: "/identity",
      label: "Plex",
      requestError,
      headers: {},
      timeoutMs: 150,
    });
    await assert.rejects(
      () => Promise.race([attempt, watchdog]),
      /Plex request timed out after 150 ms\./,
    );
  });

  test("surfaces a refused connection instead of hanging", async () => {
    const target = await validateServerTarget("http://127.0.0.1:1", targetOptions("local_only"));
    await assert.rejects(
      () => requestJson({ target, path: "/identity", label: "Plex", requestError, headers: {} }),
      /ECONNREFUSED/,
    );
  });

  test("exposes conservative defaults", () => {
    assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 15_000);
    assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 64 * 1024 * 1024);
  });
});

describe("provider parity", () => {
  // The reason the duplicate Plex copies were removed: both providers must
  // enforce the same rules. Comparing the messages the shared helper produces
  // for each label proves the rules are one implementation, differing only in
  // the provider name.
  test("Plex and Jellyfin are refused identically, differing only by name", async () => {
    for (const mode of ["offline", "local_only"]) {
      const url = mode === "offline" ? "http://127.0.0.1:32400" : "http://8.8.8.8";
      const plex = await validateServerTarget(url, { ...targetOptions(mode), label: "Plex" })
        .then(() => "", (error: Error) => error.message);
      const jellyfin = await validateServerTarget(url, { ...targetOptions(mode), label: "Jellyfin" })
        .then(() => "", (error: Error) => error.message);
      assert.ok(plex, `Plex is refused in ${mode} mode`);
      assert.equal(plex.replace(/Plex/g, "«provider»"), jellyfin.replace(/Jellyfin/g, "«provider»"));
    }

    const plexBlocked = await validateServerTarget("http://169.254.169.254", { ...targetOptions("local_only"), label: "Plex" })
      .then(() => "", (error: Error) => error.message);
    const jellyfinBlocked = await validateServerTarget("http://169.254.169.254", { ...targetOptions("local_only"), label: "Jellyfin" })
      .then(() => "", (error: Error) => error.message);
    assert.equal(
      plexBlocked.replace(/Plex/g, "«provider»"),
      jellyfinBlocked.replace(/Jellyfin/g, "«provider»"),
    );
  });
});

describe("no provider redefines the shared network helpers", () => {
  // A local copy would drift: the duplicated Plex implementation is exactly
  // what this change removed. Guarding the source keeps one canonical
  // implementation of the egress rules.
  const srcRoot = process.env.API_SERVER_SRC;
  if (!srcRoot) throw new Error("API_SERVER_SRC is required.");

  for (const relativePath of ["services/plex.ts", "services/jellyfin.ts"]) {
    test(`${relativePath} imports the shared helpers`, async () => {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const source = await readFile(join(srcRoot, relativePath), "utf8");

      assert.doesNotMatch(
        source,
        /function\s+classifyAddress\s*\(/,
        `${relativePath} must not redefine classifyAddress`,
      );
      // The providers keep thin, correctly-named wrappers; what must not
      // reappear is a second implementation of the rules themselves.
      assert.doesNotMatch(
        source,
        /\bisIP\b/,
        `${relativePath} must not import or call isIP; address classification belongs to network-target`,
      );
      assert.doesNotMatch(
        source,
        /from\s+"node:net"/,
        `${relativePath} must not reach for raw socket primitives`,
      );
      assert.doesNotMatch(
        source,
        /from\s+"node:dns\/promises"/,
        `${relativePath} must not resolve hostnames itself`,
      );
      assert.doesNotMatch(
        source,
        /from\s+"node:https?"/,
        `${relativePath} must not open raw sockets; use requestJson()`,
      );
      assert.match(
        source,
        /from\s+"\.\.\/lib\/network-target"/,
        `${relativePath} is expected to use lib/network-target`,
      );
    });
  }
});
