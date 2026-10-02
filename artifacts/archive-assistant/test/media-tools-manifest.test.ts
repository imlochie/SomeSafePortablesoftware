import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
  obtainVerifiedAsset,
  readCachedVerifiedAsset,
  resolveMediaToolsCacheDirectory,
  resolveTargetArchitecture,
  selectTargetManifest,
  verifyAssetBytes,
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

  test.each(["x64", "arm64"])(
    "pins every %s tool to an immutable release asset",
    (architecture) => {
      const selected = selectTargetManifest(manifest, architecture);

      for (const [toolName, tool] of Object.entries(selected.tools)) {
        const { pathname } = new URL(tool.url);
        const downloadTag = pathname.split("/").at(-2);

        // A rolling tag republishes its assets in place, so the pinned
        // downloadBytes/sha256 silently stop matching and the staging guard
        // fails the build. BtbN's "latest" did exactly this: the win64 zip
        // went from 169,522,175 to 169,522,154 bytes -- a 21-byte drift --
        // between two builds from an unchanged URL.
        assert.ok(
          !/^(latest|nightly|continuous|edge|dev|stable|rolling)$/i.test(
            downloadTag ?? "",
          ),
          `${architecture}/${toolName} must pin an immutable release tag, not the rolling "${downloadTag}" tag`,
        );
        assert.ok(
          !/(^|[-/])latest([-.]|$)/i.test(tool.asset),
          `${architecture}/${toolName} asset "${tool.asset}" looks like a rolling build; pin a versioned asset`,
        );
      }
    },
  );

  test.each(["x64", "arm64"])(
    "keeps the %s total download size consistent with its tools",
    (architecture) => {
      const target = manifest.architectures[architecture];
      const sum = Object.values(target.tools).reduce(
        (total, tool) => total + tool.downloadBytes,
        0,
      );

      expect(target.totalDownloadBytes).toBe(sum);
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

describe("media tool developer cache", () => {
  const fixtureBytes = Buffer.from(
    "archive-assistant cache verification fixture 0123456789",
    "utf8",
  );
  const fixtureTool = {
    asset: "fixture-asset.bin",
    url: "https://example.invalid/fixture-asset.bin",
    downloadBytes: fixtureBytes.byteLength,
    sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
  };

  async function withTempCache(run: (cacheDirectory: string) => Promise<void>) {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "archive-media-cache-"));
    try {
      await run(cacheDirectory);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  }

  test("accepts a cached asset that matches the exact size and SHA-256", async () => {
    await withTempCache(async (cacheDirectory) => {
      await writeFile(join(cacheDirectory, fixtureTool.asset), fixtureBytes);
      const cached = await readCachedVerifiedAsset(fixtureTool, cacheDirectory);
      expect(Buffer.isBuffer(cached)).toBe(true);
      expect(cached?.equals(fixtureBytes)).toBe(true);
    });
  });

  test("treats a missing cached asset as absent so staging falls back to the network", async () => {
    await withTempCache(async (cacheDirectory) => {
      expect(await readCachedVerifiedAsset(fixtureTool, cacheDirectory)).toBeNull();
    });
  });

  test("rejects a cached asset with the wrong byte size", async () => {
    await withTempCache(async (cacheDirectory) => {
      await writeFile(
        join(cacheDirectory, fixtureTool.asset),
        fixtureBytes.subarray(0, fixtureTool.byteLength - 1),
      );
      await expect(
        readCachedVerifiedAsset(fixtureTool, cacheDirectory),
      ).rejects.toThrow(/Cached media tool asset failed verification.*Unexpected size/s);
    });
  });

  test("rejects a cached asset with the right size but the wrong checksum", async () => {
    await withTempCache(async (cacheDirectory) => {
      const corrupted = Buffer.from(fixtureBytes);
      corrupted[0] = corrupted[0] ^ 0xff;
      await writeFile(join(cacheDirectory, fixtureTool.asset), corrupted);
      await expect(
        readCachedVerifiedAsset(fixtureTool, cacheDirectory),
      ).rejects.toThrow(/Cached media tool asset failed verification.*Checksum mismatch/s);
    });
  });

  test("verifies byte buffers with the manifest size and SHA-256", () => {
    expect(() => verifyAssetBytes(fixtureBytes, fixtureTool)).not.toThrow();
    expect(() =>
      verifyAssetBytes(Buffer.from("too short"), fixtureTool),
    ).toThrow(/Unexpected size/);
    const wrongHashTool = { ...fixtureTool, sha256: "0".repeat(64) };
    expect(() => verifyAssetBytes(fixtureBytes, wrongHashTool)).toThrow(
      /Checksum mismatch/,
    );
  });

  test("resolves the cache directory from ARCHIVE_MEDIA_TOOLS_CACHE", () => {
    expect(resolveMediaToolsCacheDirectory({})).toBeNull();
    expect(
      resolveMediaToolsCacheDirectory({ ARCHIVE_MEDIA_TOOLS_CACHE: "   " }),
    ).toBeNull();
    expect(
      resolveMediaToolsCacheDirectory({
        ARCHIVE_MEDIA_TOOLS_CACHE: "media-tool-cache",
      }),
    ).toBe(resolve("media-tool-cache"));
  });

  test("stages a verified cached asset without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await withTempCache(async (cacheDirectory) => {
        const target = join(cacheDirectory, "staged-asset.bin");
        await writeFile(join(cacheDirectory, fixtureTool.asset), fixtureBytes);
        await obtainVerifiedAsset(fixtureTool, target, cacheDirectory);
        expect((await readFile(target)).equals(fixtureBytes)).toBe(true);
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("falls back to the network download when the cache is absent", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => Uint8Array.from(fixtureBytes).buffer,
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await withTempCache(async (cacheDirectory) => {
        const target = join(cacheDirectory, "staged-asset.bin");
        await obtainVerifiedAsset(fixtureTool, target, cacheDirectory);
        expect((await readFile(target)).equals(fixtureBytes)).toBe(true);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
