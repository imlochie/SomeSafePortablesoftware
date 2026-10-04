/**
 * CORS boundary for the packaged desktop shell.
 *
 * In the desktop build the frontend is served by the webview from its own
 * origin while the API listens on http://127.0.0.1:<ephemeral port>. Every API
 * call is therefore cross-origin and subject to CORS, unlike the browser build
 * where the Vite dev server proxies /api and requests stay same-origin.
 *
 * The webview origin is platform-specific. macOS and Linux use the custom
 * scheme tauri://localhost, which the protocol check already accepted. Windows
 * WebView2 serves the bundled frontend from http://tauri.localhost -- an http
 * origin whose hostname is "tauri.localhost", not "localhost". That matched
 * neither the hostname list nor the tauri: protocol check, so the Windows
 * desktop app was refused by its own local API.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isAllowedLocalOrigin } from "../src/lib/runtime-config";

describe("desktop webview CORS origins", () => {
  test("accepts the Windows WebView2 origin", () => {
    // The exact origin the packaged Windows app presents.
    assert.equal(isAllowedLocalOrigin("http://tauri.localhost"), true);
    assert.equal(isAllowedLocalOrigin("https://tauri.localhost"), true);
  });

  test("accepts the macOS and Linux webview origin", () => {
    assert.equal(isAllowedLocalOrigin("tauri://localhost"), true);
  });

  test("keeps accepting loopback origins used by the browser build", () => {
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:51731",
    ]) {
      assert.equal(isAllowedLocalOrigin(origin), true, origin);
    }
  });

  test("still refuses remote origins", () => {
    for (const origin of [
      "http://evil.example.com",
      "https://tauri.localhost.evil.com",
      "http://notlocalhost",
      "not a url",
    ]) {
      assert.equal(isAllowedLocalOrigin(origin), false, origin);
    }
  });
});
