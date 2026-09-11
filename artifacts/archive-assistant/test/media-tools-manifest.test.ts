import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
  resolveTargetArchitecture,
  selectTargetManifest,
} from "../scripts/stage-media-tools.mjs";

const manifestPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "media-tools-manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

describe("native media tool manifest", () => {
  test.each([
    ["x64", "x86_64-pc-windows-msvc"],
    ["arm64", "aarch64-pc-windows-msvc"],
  ])(
    "selects the verified %s Windows target and triple",
    (architecture, targetTriple) => {
      const selected = selectTargetManifest(manifest, architecture);

      expect(selected.architecture).toBe(architecture);
      expect(selected.targetTriple).toBe(targetTriple);
      expect(selected.platform).toBe("windows");
    },
  );

  test.each(["x64", "arm64"])(
    "requires complete metadata for every %s tool",
    (architecture) => {
      const selected = selectTargetManifest(manifest, architecture);

      for (const [toolName, tool] of Object.entries(selected.tools)) {
        assert.ok(
          typeof tool === "object" && tool !== null,
          `${architecture}/${toolName} must be an object`,
        );
        assert.match(
          tool.asset,
          /^[^/\\]+$/,
          `${architecture}/${toolName} must have a valid asset name`,
        );
        assert.match(
          tool.sha256,
          /^[a-f0-9]{64}$/,
          `${architecture}/${toolName} must have a lowercase SHA-256`,
        );
        assert.ok(
          typeof tool.license === "string" && tool.license.trim().length > 0,
          `${architecture}/${toolName} must declare a license`,
        );
        assert.ok(
          Number.isInteger(tool.downloadBytes) && tool.downloadBytes > 0,
          `${architecture}/${toolName} must have a positive package size`,
        );
        assert.equal(
          new URL(tool.url).pathname.split("/").pop(),
          tool.asset,
          `${architecture}/${toolName} asset must match its download URL`,
        );
      }
    },
  );

  test("rejects unsupported architectures before any release asset download", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => selectTargetManifest(manifest, "ia32")).toThrow(
      'Unsupported Windows architecture "ia32".',
    );
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  test("normalizes supported architecture aliases", () => {
    expect(resolveTargetArchitecture(" AMD64 ")).toBe("x64");
    expect(resolveTargetArchitecture("AARCH64")).toBe("arm64");
  });
});
